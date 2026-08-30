using System;
using System.Collections.Generic;
using Breakpoint.Simulation;
using UnityEngine;

namespace Breakpoint.Presentation
{
    /// <summary>
    /// Owns the authoritative simulation and advances it on a fixed timestep.
    ///
    /// This is the *only* place Unity time touches physics, and it touches it
    /// through <see cref="FixedStepDriver"/>, which spends wall-clock seconds in
    /// whole 1/120 s steps. Rendering may run at any rate; the simulation does
    /// not care and does not change.
    ///
    /// Note what this class does not do. It never writes a Transform back into
    /// the world, never asks PhysX anything, and never lets a presenter mutate a
    /// ball. Presentation reads; simulation decides. Unity rigidbodies are not
    /// used for ball motion at all — the acceptance rule for this migration is
    /// that PhysX must never become the authority, and the way that is
    /// guaranteed is by the simulation assembly having no engine reference at
    /// all (see Breakpoint.Simulation.asmdef, "noEngineReferences": true).
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class SimulationRunner : MonoBehaviour
    {
        /// <summary>Raised for each event the simulation produced this frame.</summary>
        public event Action<SimEvent> Observed;

        /// <summary>Raised once when the table comes to rest after a shot.</summary>
        public event Action Settled;

        private FixedStepDriver _driver;
        private int _drained;
        private bool _wasSettled = true;

        public PhysicsWorld World { get; private set; }

        /// <summary>Fraction of a step left over, for presentation interpolation.</summary>
        public double Alpha => _driver?.Alpha ?? 0.0;

        /// <summary>True while the balls are moving and input should be locked.</summary>
        public bool IsRunning => World != null && !World.IsSettled();

        private void Awake()
        {
            Rebuild();
        }

        /// <summary>Rack up and start again.</summary>
        public void Rebuild()
        {
            World = Rack.CreateRackedWorld();
            _driver = new FixedStepDriver(World);
            _drained = 0;
            _wasSettled = true;
        }

        /// <summary>
        /// Commit a shot. Returns false if the table is still moving, which is
        /// the authoritative input lock — a UI that forgets to disable itself
        /// still cannot fire a second shot.
        /// </summary>
        public bool Strike(ShotInput input)
        {
            if (World == null || IsRunning) return false;

            BallBody cue = World.CueBall;
            if (cue == null || cue.Pocketed) return false;

            World.ClearEvents();
            _drained = 0;

            SpinModel.Apply(cue, new CueStrike
            {
                Direction = new Vec2(Math.Cos(input.AimAngle), Math.Sin(input.AimAngle)),
                Speed = PowerToSpeed(input.Power),
                TipX = input.TipX,
                TipY = input.TipY,
            });

            _wasSettled = false;
            return true;
        }

        /// <summary>
        /// Map a normalised power dial onto a cue speed.
        ///
        /// Squared response: the low half of the travel is where touch shots
        /// live, and a linear dial makes every soft shot feel the same.
        /// </summary>
        public static double PowerToSpeed(double power)
        {
            const double minimum = 0.6;
            double clamped = Numeric.Clamp(power, 0.0, 1.0);
            return minimum + (PhysicsConstants.MaxCueSpeed - minimum) * clamped * clamped;
        }

        /// <summary>
        /// Advance the world by one frame's worth of wall-clock time.
        ///
        /// Called explicitly by <see cref="BreakpointBootstrap"/> rather than
        /// from this component's own Update, so that "advance the world" and
        /// "read the world" cannot be reordered by Unity's script execution
        /// order. A presenter that read a half-stepped world would show a ball
        /// in a position the simulation never held.
        /// </summary>
        public void Advance(float deltaTime)
        {
            if (World == null) return;

            _driver.Advance(deltaTime);
            DrainEvents();

            bool settled = World.IsSettled();
            if (settled && !_wasSettled)
            {
                _wasSettled = true;
                Settled?.Invoke();
            }
            else if (!settled)
            {
                _wasSettled = false;
            }
        }

        /// <summary>
        /// Hand out the events produced since the last frame.
        ///
        /// Presentation observes; it is never called *by* the simulation. That
        /// separation is what lets audio and VFX hang off contacts later without
        /// any of it reaching back into deterministic state.
        /// </summary>
        private void DrainEvents()
        {
            IReadOnlyList<SimEvent> events = World.Events;
            while (_drained < events.Count)
            {
                Observed?.Invoke(events[_drained]);
                _drained++;
            }
        }
    }
}
