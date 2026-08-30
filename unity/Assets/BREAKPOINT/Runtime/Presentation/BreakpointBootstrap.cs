using System;
using System.Collections.Generic;
using Breakpoint.Input;
using Breakpoint.Rendering;
using Breakpoint.Simulation;
using Breakpoint.UI;
using UnityEngine;

namespace Breakpoint.Presentation
{
    /// <summary>
    /// Builds and drives the playable scene.
    ///
    /// The scene asset holds one object: this component. Everything else —
    /// table, balls, cue, camera, lighting, HUD, input — is constructed here at
    /// runtime from the simulation's own geometry. That is a deliberate choice
    /// for this phase. A scene whose contents are generated cannot drift out of
    /// agreement with the physics the way a hand-placed one can, it reviews as a
    /// diff instead of as a binary, and it means the whole thing can be built
    /// before any authored art exists. When production art arrives it replaces
    /// materials and meshes; the structure here does not change.
    ///
    /// The frame order matters and is explicit:
    ///
    ///   1. input produces intents
    ///   2. the simulation advances by whole fixed steps
    ///   3. presenters read the resulting state
    ///
    /// None of that is left to Unity's script execution order, because a
    /// presenter that read a half-stepped world would draw a position the
    /// simulation never held.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class BreakpointBootstrap : MonoBehaviour, IShotIntents
    {
        [Tooltip("Optional. Falls back to the built-in Emerald Classic theme.")]
        public BreakpointTheme Theme;

        private MaterialLibrary _materials;
        private TableBuilder _table;
        private SceneLighting _lighting;
        private CuePresenter _cue;
        private AimOverlay _aim;
        private GameCameraRig _rig;
        private SimulationRunner _runner;
        private ShotInputSource _input;
        private Hud _hud;
        private Camera _camera;

        private readonly List<BallPresenter> _presenters = new List<BallPresenter>();

        private double _aimAngle;
        private float _power;
        private float _tipX;
        private float _tipY;
        private bool _wasRunning;

        public IReadOnlyList<BallPresenter> Presenters => _presenters;
        public SimulationRunner Runner => _runner;
        public GameCameraRig Rig => _rig;

        private void Awake()
        {
            BreakpointTheme theme = Theme != null ? Theme : BreakpointTheme.CreateDefault();

            _materials = new MaterialLibrary();
            _runner = gameObject.AddComponent<SimulationRunner>();
            _runner.Observed += OnSimulationEvent;
            _runner.Settled += OnSettled;

            TableGeometry geometry = _runner.World.Table;

            _table = new TableBuilder(_materials);
            _table.Build(geometry, theme, transform);

            _lighting = new SceneLighting();
            _lighting.Build(_materials, theme, (float)geometry.Length, transform);

            BuildBalls();

            _cue = new CuePresenter();
            _cue.Build(_materials, transform);

            _aim = new AimOverlay();
            _aim.Build(_materials, transform);

            BuildCamera(geometry);

            _hud = new Hud();
            _hud.Build(transform);
            _hud.SetStatus("Drag the table to aim  ·  pull the cue back to shoot");

            _input = gameObject.AddComponent<ShotInputSource>();
            _input.Bind(this, _camera, _table.ClothTarget, _hud.CuePad, _hud.SpinDial);

            // Aim up the table from the head string, which is where a break is
            // taken from and the only sensible opening view.
            _aimAngle = 0.0;
        }

        private void BuildCamera(TableGeometry geometry)
        {
            var go = new GameObject("MainCamera");
            go.transform.SetParent(transform, false);
            go.tag = "MainCamera";

            _camera = go.AddComponent<Camera>();
            _camera.clearFlags = CameraClearFlags.SolidColor;
            // Not pure black: a dead-black surround makes the cloth's own
            // shadow terminator disappear and the table look pasted on.
            _camera.backgroundColor = BrandPalette.Obsidian;
            go.AddComponent<AudioListener>();

            _rig = go.AddComponent<GameCameraRig>();
            _rig.Bind(_camera, geometry);
        }

        private void BuildBalls()
        {
            var root = new GameObject("Balls").transform;
            root.SetParent(transform, false);

            IReadOnlyList<BallBody> balls = _runner.World.Balls;
            for (int i = 0; i < balls.Count; i++)
            {
                BallBody ball = balls[i];

                var holder = new GameObject("Ball_" + ball.Number);
                holder.transform.SetParent(root, false);

                // The visible sphere is a child, so a pocket animation can
                // scale it without disturbing the position the presenter writes.
                var model = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                model.name = "Model";
                UnityEngine.Object.Destroy(model.GetComponent<Collider>());
                model.transform.SetParent(holder.transform, false);
                model.transform.localScale = Vector3.one * (float)(2.0 * PhysicsConstants.BallRadius);

                var renderer = model.GetComponent<MeshRenderer>();
                renderer.sharedMaterial = _materials.Ball(ball.Number);
                renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
                renderer.receiveShadows = true;

                var presenter = holder.AddComponent<BallPresenter>();
                presenter.Bind(ball, model.transform);
                _presenters.Add(presenter);
            }
        }

        private void Update()
        {
            float dt = Time.deltaTime;

            // 1. Advance the authoritative simulation.
            _runner.Advance(dt);

            bool running = _runner.IsRunning;

            // 2. Read it.
            for (int i = 0; i < _presenters.Count; i++) _presenters[i].Sync(dt);

            BallBody cue = _runner.World.CueBall;
            Vec2 cuePosition = cue != null ? cue.Position : Vec2.Zero;

            _rig.Advance(cuePosition, _aimAngle, running, dt);

            bool aiming = !running && cue != null && !cue.Pocketed;
            _cue.SetVisible(aiming);
            if (aiming)
            {
                _cue.Aim(cuePosition, _aimAngle, _power, _tipX, _tipY);
                _aim.Show(_runner.World, _aimAngle);
            }
            else
            {
                _aim.SetVisible(false);
            }

            _hud.SetInteractable(!running);
            _hud.SetPower(_power);

            // The fixture hangs between an overhead camera and the cloth; from
            // the pulled-back pose it is a black slab across the middle of the
            // table, so it is hidden once the camera climbs above it.
            if (_lighting.Fixture != null)
            {
                bool below = _camera.transform.position.y < SceneLighting.FixtureHeight;
                if (_lighting.Fixture.gameObject.activeSelf != below)
                {
                    _lighting.Fixture.gameObject.SetActive(below);
                }
            }

            if (running != _wasRunning)
            {
                _wasRunning = running;
                if (running) _hud.SetStatus("");
            }
        }

        // ------------------------------------------------------------- intents

        public void RotateAim(double delta)
        {
            if (_runner.IsRunning) return;
            _aimAngle = Wrap(_aimAngle + delta);
        }

        public void AdjustElevation(float delta) => _rig.AdjustElevation(delta);

        public void Zoom(float factor) => _rig.AdjustDistance(factor);

        public void AimAt(Vec2 tablePoint)
        {
            if (_runner.IsRunning) return;
            BallBody cue = _runner.World.CueBall;
            if (cue == null || cue.Pocketed) return;

            double dx = tablePoint.X - cue.Position.X;
            double dy = tablePoint.Y - cue.Position.Y;
            if (dx * dx + dy * dy < 1e-8) return;
            _aimAngle = Math.Atan2(dy, dx);
        }

        public void SetPull(float pull)
        {
            if (_runner.IsRunning) return;
            _power = Mathf.Clamp01(pull);
        }

        public void ReleasePull(float? power)
        {
            if (!power.HasValue)
            {
                _power = 0f;
                return;
            }

            Fire(power.Value);
            _power = 0f;
        }

        public void SetTip(float x, float y)
        {
            if (_runner.IsRunning) return;

            double clampedX, clampedY;
            // The same clamp the physics applies, so the dial cannot show a tip
            // position the cue could not actually reach without miscuing.
            SpinModel.ClampTipOffset(x, y, out clampedX, out clampedY);
            _tipX = (float)clampedX;
            _tipY = (float)clampedY;
            _hud.SetTip(_tipX, _tipY);
        }

        public void AnyInteraction()
        {
        }

        /// <summary>Commit the shot. The runner is free to refuse it.</summary>
        public bool Fire(float power)
        {
            BallBody cue = _runner.World.CueBall;
            if (cue == null) return false;

            return _runner.Strike(new ShotInput
            {
                AimAngle = _aimAngle,
                Power = power,
                TipX = _tipX,
                TipY = _tipY,
                CueBallPosition = cue.Position,
            });
        }

        /// <summary>Rack up again and reset the presentation to match.</summary>
        public void Rebuild()
        {
            _runner.Rebuild();

            IReadOnlyList<BallBody> balls = _runner.World.Balls;
            for (int i = 0; i < _presenters.Count && i < balls.Count; i++)
            {
                _presenters[i].Bind(balls[i], _presenters[i].transform.GetChild(0));
                _presenters[i].ResetVisual();
            }

            _aimAngle = 0.0;
            _power = 0f;
            _rig.Reset();
        }

        private void OnSimulationEvent(SimEvent e)
        {
            // The seam audio and VFX hang off. Nothing is wired to it yet:
            // sound and particles are not Phase A, and inventing them here
            // would mean inventing the asset list they need as well.
        }

        private void OnSettled()
        {
            _hud.SetStatus("Your shot");
        }

        private static double Wrap(double angle)
        {
            const double twoPi = Math.PI * 2.0;
            angle %= twoPi;
            if (angle < 0.0) angle += twoPi;
            return angle;
        }

        private void OnDestroy()
        {
            if (_runner != null)
            {
                _runner.Observed -= OnSimulationEvent;
                _runner.Settled -= OnSettled;
            }
            if (_table != null) _table.Dispose();
            if (_materials != null) _materials.Dispose();
        }
    }
}
