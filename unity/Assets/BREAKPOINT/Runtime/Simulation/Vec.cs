using System;

namespace Breakpoint.Simulation
{
    /// <summary>
    /// Minimal vector maths for the simulation core.
    ///
    /// Everything here is <c>double</c>, deliberately. The TypeScript reference
    /// runs on JavaScript Numbers, which are IEEE-754 binary64; using
    /// <c>float</c> inside the authoritative simulation would silently change
    /// results and make parity with the reference unachievable. Unity is welcome
    /// to take single-precision copies for rendering — see the presentation
    /// bridge — but it never hands them back.
    ///
    /// These are readonly structs so they live on the stack and cost no
    /// allocation inside the 120 Hz loop.
    /// </summary>
    public readonly struct Vec2 : IEquatable<Vec2>
    {
        public readonly double X;
        public readonly double Y;

        public Vec2(double x, double y)
        {
            X = x;
            Y = y;
        }

        public static readonly Vec2 Zero = new Vec2(0.0, 0.0);

        public double Length => Math.Sqrt(X * X + Y * Y);
        public double LengthSquared => X * X + Y * Y;
        public bool IsFinite => Numeric.IsFinite(X) && Numeric.IsFinite(Y);

        public static Vec2 operator +(Vec2 a, Vec2 b) => new Vec2(a.X + b.X, a.Y + b.Y);
        public static Vec2 operator -(Vec2 a, Vec2 b) => new Vec2(a.X - b.X, a.Y - b.Y);
        public static Vec2 operator *(Vec2 a, double s) => new Vec2(a.X * s, a.Y * s);
        public static Vec2 operator *(double s, Vec2 a) => new Vec2(a.X * s, a.Y * s);
        public static Vec2 operator -(Vec2 a) => new Vec2(-a.X, -a.Y);

        public static double Dot(Vec2 a, Vec2 b) => a.X * b.X + a.Y * b.Y;

        /// <summary>Normalise, returning zero for a degenerate input rather than NaN.</summary>
        public Vec2 Normalized()
        {
            double length = Math.Sqrt(X * X + Y * Y);
            if (length < 1e-12) return Zero;
            return new Vec2(X / length, Y / length);
        }

        public bool Equals(Vec2 other) => X.Equals(other.X) && Y.Equals(other.Y);
        public override bool Equals(object obj) => obj is Vec2 other && Equals(other);
        public override int GetHashCode() => unchecked((X.GetHashCode() * 397) ^ Y.GetHashCode());
        public override string ToString() => "(" + X.ToString("R") + ", " + Y.ToString("R") + ")";
    }

    /// <summary>
    /// Three-component vector, used for angular velocity.
    ///
    /// Linear motion is planar (<see cref="Vec2"/>) because balls never leave
    /// the cloth, but spin needs all three axes: X and Y carry topspin and
    /// backspin, Z carries English.
    /// </summary>
    public readonly struct Vec3 : IEquatable<Vec3>
    {
        public readonly double X;
        public readonly double Y;
        public readonly double Z;

        public Vec3(double x, double y, double z)
        {
            X = x;
            Y = y;
            Z = z;
        }

        public static readonly Vec3 Zero = new Vec3(0.0, 0.0, 0.0);

        public double Length => Math.Sqrt(X * X + Y * Y + Z * Z);
        public double LengthSquared => X * X + Y * Y + Z * Z;
        public bool IsFinite => Numeric.IsFinite(X) && Numeric.IsFinite(Y) && Numeric.IsFinite(Z);

        public static Vec3 operator +(Vec3 a, Vec3 b) => new Vec3(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
        public static Vec3 operator -(Vec3 a, Vec3 b) => new Vec3(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
        public static Vec3 operator *(Vec3 a, double s) => new Vec3(a.X * s, a.Y * s, a.Z * s);
        public static Vec3 operator *(double s, Vec3 a) => new Vec3(a.X * s, a.Y * s, a.Z * s);

        public static double Dot(Vec3 a, Vec3 b) => a.X * b.X + a.Y * b.Y + a.Z * b.Z;

        public static Vec3 Cross(Vec3 a, Vec3 b) => new Vec3(
            a.Y * b.Z - a.Z * b.Y,
            a.Z * b.X - a.X * b.Z,
            a.X * b.Y - a.Y * b.X);

        public bool Equals(Vec3 other) => X.Equals(other.X) && Y.Equals(other.Y) && Z.Equals(other.Z);
        public override bool Equals(object obj) => obj is Vec3 other && Equals(other);

        public override int GetHashCode()
        {
            unchecked
            {
                int hash = X.GetHashCode();
                hash = (hash * 397) ^ Y.GetHashCode();
                return (hash * 397) ^ Z.GetHashCode();
            }
        }

        public override string ToString() =>
            "(" + X.ToString("R") + ", " + Y.ToString("R") + ", " + Z.ToString("R") + ")";
    }

    /// <summary>Numeric helpers shared across the simulation.</summary>
    public static class Numeric
    {
        /// <summary>
        /// True only for a real, representable number.
        ///
        /// This is the NaN/Infinity tripwire. It exists as one function so the
        /// check cannot drift between the places that guard state.
        /// </summary>
        public static bool IsFinite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);

        public static double Clamp(double value, double min, double max)
        {
            if (value < min) return min;
            if (value > max) return max;
            return value;
        }
    }
}
