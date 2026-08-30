using System;

namespace Breakpoint.Simulation
{
    /// <summary>
    /// One ball's complete dynamic state.
    ///
    /// <see cref="Spin"/> is the full angular velocity vector in world axes:
    /// X and Y are the rolling axes (what topspin and backspin live on) and Z is
    /// English. Everything presentation needs to orient a ball comes from
    /// integrating this, so spin is never faked visually.
    ///
    /// A class rather than a struct: the world holds and mutates these in place
    /// through a whole shot, and copying a struct around would make it far too
    /// easy to update a temporary instead of the ball.
    /// </summary>
    public sealed class BallBody
    {
        /// <summary>Index in the world's ball list. Stable for the life of a shot.</summary>
        public readonly int Id;

        /// <summary>0 = cue ball, 1..15 = object balls.</summary>
        public readonly int Number;

        public Vec2 Position;
        public Vec2 Velocity;
        public Vec3 Spin;

        /// <summary>Accumulated orientation as a quaternion (x, y, z, w). Presentation only.</summary>
        public Quat Orientation;

        /// <summary>True once the ball has dropped; pocketed balls leave the simulation.</summary>
        public bool Pocketed;

        /// <summary>Which pocket it fell in, for the shot record.</summary>
        public string PocketId;

        /// <summary>True when both velocity and spin are exactly zero.</summary>
        public bool Resting;

        public BallBody(int id, int number, Vec2 position)
        {
            Id = id;
            Number = number;
            Position = position;
            Velocity = Vec2.Zero;
            Spin = Vec3.Zero;
            Orientation = Quat.Identity;
            Pocketed = false;
            PocketId = null;
            Resting = true;
        }

        public BallBody Clone()
        {
            return new BallBody(Id, Number, Position)
            {
                Velocity = Velocity,
                Spin = Spin,
                Orientation = Orientation,
                Pocketed = Pocketed,
                PocketId = PocketId,
                Resting = Resting,
            };
        }

        /// <summary>Copy another ball's dynamic state onto this one, in place.</summary>
        public void CopyStateFrom(BallBody other)
        {
            Position = other.Position;
            Velocity = other.Velocity;
            Spin = other.Spin;
            Orientation = other.Orientation;
            Pocketed = other.Pocketed;
            PocketId = other.PocketId;
            Resting = other.Resting;
        }

        /// <summary>
        /// Velocity of the contact patch where the ball touches the cloth, at
        /// r = (0, 0, −R) from the centre: u = v + ω × r.
        ///
        /// Expanding the cross product for that r gives
        /// u = (vx − R·ωy, vy + R·ωx). When u is zero the ball rolls without
        /// slipping; while it is non-zero the ball is sliding.
        /// </summary>
        public Vec2 ContactVelocity()
        {
            return new Vec2(
                Velocity.X - PhysicsConstants.BallRadius * Spin.Y,
                Velocity.Y + PhysicsConstants.BallRadius * Spin.X);
        }

        /// <summary>Is this ball below both rest thresholds?</summary>
        public bool BelowRestThreshold()
        {
            double v = Math.Sqrt(Velocity.X * Velocity.X + Velocity.Y * Velocity.Y);
            double w = Math.Sqrt(Spin.X * Spin.X + Spin.Y * Spin.Y + Spin.Z * Spin.Z);
            return v < PhysicsConstants.RestSpeed && w < PhysicsConstants.RestSpin;
        }

        /// <summary>Snap a near-stopped ball to exact rest so the shot terminates.</summary>
        public void ForceRest()
        {
            Velocity = Vec2.Zero;
            Spin = Vec3.Zero;
            Resting = true;
        }

        public bool IsFinite =>
            Position.IsFinite && Velocity.IsFinite && Spin.IsFinite;

        /// <summary>
        /// Roll the presentation orientation forward by ω·dt.
        ///
        /// This is bookkeeping on top of the real physics, not a substitute for
        /// it: the quaternion is derived from the same <see cref="Spin"/> that
        /// drives the trajectory, so the visible rotation and the physical
        /// rotation cannot disagree.
        /// </summary>
        public void IntegrateOrientation(double dt)
        {
            double wx = Spin.X;
            double wy = Spin.Y;
            double wz = Spin.Z;
            double magnitude = Math.Sqrt(wx * wx + wy * wy + wz * wz);
            if (magnitude < 1e-9) return;

            double half = magnitude * dt / 2.0;
            double s = Math.Sin(half) / magnitude;
            var delta = new Quat(wx * s, wy * s, wz * s, Math.Cos(half));
            Orientation = Quat.Multiply(delta, Orientation).Normalized();
        }
    }

    /// <summary>
    /// A quaternion, carried purely so presentation can show a ball rotating.
    /// The simulation never reads it back.
    /// </summary>
    public readonly struct Quat
    {
        public readonly double X;
        public readonly double Y;
        public readonly double Z;
        public readonly double W;

        public Quat(double x, double y, double z, double w)
        {
            X = x;
            Y = y;
            Z = z;
            W = w;
        }

        public static readonly Quat Identity = new Quat(0.0, 0.0, 0.0, 1.0);

        public bool IsFinite =>
            Numeric.IsFinite(X) && Numeric.IsFinite(Y) && Numeric.IsFinite(Z) && Numeric.IsFinite(W);

        public static Quat Multiply(Quat d, Quat q)
        {
            return new Quat(
                d.W * q.X + d.X * q.W + d.Y * q.Z - d.Z * q.Y,
                d.W * q.Y - d.X * q.Z + d.Y * q.W + d.Z * q.X,
                d.W * q.Z + d.X * q.Y - d.Y * q.X + d.Z * q.W,
                d.W * q.W - d.X * q.X - d.Y * q.Y - d.Z * q.Z);
        }

        public Quat Normalized()
        {
            double inv = 1.0 / Math.Sqrt(X * X + Y * Y + Z * Z + W * W);
            return new Quat(X * inv, Y * inv, Z * inv, W * inv);
        }
    }
}
