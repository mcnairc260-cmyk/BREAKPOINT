using Breakpoint.Simulation;
using UnityEngine;

namespace Breakpoint.Presentation
{
    /// <summary>
    /// Unity-typed wrappers over <see cref="RenderFrame"/>.
    ///
    /// The maths lives in the simulation assembly so the engine-free harness can
    /// test it; this file only changes doubles into floats. Every conversion
    /// from simulation state to a Transform goes through here, so there is
    /// exactly one place a frame error could hide, and it has tests.
    ///
    /// Precision: presentation is the only place a narrowing to float is
    /// allowed. A float carries ~7 significant digits, which on a 2.54 m table
    /// is sub-micron — far below anything visible — while the authoritative
    /// state stays double throughout. Nothing converted here is ever read back.
    /// </summary>
    public static class TableFrame
    {
        /// <summary>A point on the cloth, lifted to <paramref name="height"/> metres.</summary>
        public static Vector3 Plane(Vec2 v, float height) =>
            new Vector3((float)v.X, height, (float)v.Y);

        /// <summary>A direction in the cloth plane, as a flat render-frame vector.</summary>
        public static Vector3 Direction(Vec2 v) =>
            new Vector3((float)v.X, 0f, (float)v.Y);

        /// <summary>A simulation vector in the render frame.</summary>
        public static Vector3 Vector(Vec3 v)
        {
            Vec3 r = RenderFrame.ToRender(v);
            return new Vector3((float)r.X, (float)r.Y, (float)r.Z);
        }

        /// <summary>A simulation orientation in the render frame.</summary>
        public static Quaternion Rotation(Quat q)
        {
            Quat r = RenderFrame.ToRender(q);
            return new Quaternion((float)r.X, (float)r.Y, (float)r.Z, (float)r.W);
        }

        /// <summary>A render-frame point projected back onto the cloth plane.</summary>
        public static Vec2 ToPlane(Vector3 v) => new Vec2(v.x, v.z);

        /// <summary>Table heading, in radians, of a flat render-frame direction.</summary>
        public static double Heading(Vector3 v) => Mathf.Atan2(v.z, v.x);
    }
}
