using System;

namespace Breakpoint.Simulation
{
    /// <summary>
    /// The only bridge from wall-clock frames to simulation steps.
    ///
    /// Frames arrive at whatever rate the display and the device manage. The
    /// simulation must not care. This accumulates real elapsed time and spends
    /// it in whole <see cref="PhysicsConstants.FixedDt"/> steps, so a 30 fps
    /// phone and a 120 fps tablet run the same number of steps over the same
    /// simulated interval and reach the same result. The leftover is exposed as
    /// <see cref="Alpha"/> purely so presentation can interpolate; nothing
    /// physical ever reads it.
    ///
    /// <see cref="MaxFrameSeconds"/> caps how much time one frame may spend.
    /// Without it, an app returning from the background hands over several
    /// seconds at once and the catch-up loop stalls the game — the classic
    /// spiral of death.
    ///
    /// This lives in the simulation assembly, not in a MonoBehaviour, so a
    /// headless test can drive frames without loading a scene.
    /// </summary>
    public sealed class FixedStepDriver
    {
        private readonly PhysicsWorld _world;
        private readonly double _maxFrameSeconds;
        private double _accumulator;

        public FixedStepDriver(PhysicsWorld world, double maxFrameSeconds = 0.25)
        {
            _world = world ?? throw new ArgumentNullException(nameof(world));
            _maxFrameSeconds = maxFrameSeconds;
        }

        /// <summary>Fraction of a step left over, in [0, 1). Presentation interpolation only.</summary>
        public double Alpha { get; private set; }

        /// <summary>Steps executed on the most recent <see cref="Advance"/>.</summary>
        public int LastStepCount { get; private set; }

        /// <summary>Feed one frame's elapsed seconds. Returns the number of steps run.</summary>
        public int Advance(double frameSeconds)
        {
            if (!Numeric.IsFinite(frameSeconds) || frameSeconds <= 0.0)
            {
                LastStepCount = 0;
                return 0;
            }

            _accumulator += Math.Min(frameSeconds, _maxFrameSeconds);

            int steps = 0;
            while (_accumulator >= PhysicsConstants.FixedDt)
            {
                _world.Step();
                _accumulator -= PhysicsConstants.FixedDt;
                steps++;
            }

            Alpha = _accumulator / PhysicsConstants.FixedDt;
            LastStepCount = steps;
            return steps;
        }

        public void Reset()
        {
            _accumulator = 0.0;
            Alpha = 0.0;
            LastStepCount = 0;
        }
    }
}
