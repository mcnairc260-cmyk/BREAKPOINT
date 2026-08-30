namespace Breakpoint.Simulation
{
    /// <summary>
    /// The one place the physics frame is converted to the render frame.
    ///
    /// The simulation works in a right-handed frame with the cloth at z = 0 and
    /// +z up, because that is the convention every billiards reference uses and
    /// it keeps the spin derivations readable. Unity is y-up and left-handed.
    /// The mapping is
    ///
    ///     render = ( x, z, y )
    ///
    /// Writing the screen basis as (right, up, into-screen) — which is a
    /// left-handed triple — the physics axes land as x̂ = right, ẑ = up,
    /// ŷ = into-screen, and Unity's axes are already X̂ = right, Ŷ = up,
    /// Ẑ = into-screen. So the render vector *is* the screen vector, and the
    /// table looks the same as it does in the TypeScript reference rather than
    /// mirrored.
    ///
    /// Rotations need one more step. The map P is a reflection (it swaps two
    /// axes, det = −1), so a physics rotation R becomes P·R·P in render
    /// coordinates. Expanding R = I + 2w[v]× + 2[v]×² and using
    /// P[v]×P⁻¹ = det(P)·[Pv]× = −[Pv]× gives
    ///
    ///     P·R·P = I − 2w[Pv]× + 2[Pv]×²
    ///
    /// which is the rotation of the quaternion (Pv, −w). Hence the vector part
    /// is permuted and the scalar part is negated.
    ///
    /// Getting this wrong would mirror every spin — English would visibly curve
    /// the wrong way, and a ball rolling right would appear to spin backwards —
    /// which is exactly the kind of faked-looking spin this project must not
    /// ship. It is therefore kept here, in the engine-free assembly, so the
    /// standalone test harness can exercise it without Unity present.
    ///
    /// Nothing in the simulation ever reads these functions. They exist for
    /// presentation only, and the conversion is strictly one-way at the point
    /// of use: render code reads simulation state, never the reverse.
    /// </summary>
    public static class RenderFrame
    {
        /// <summary>Physics vector → render vector.</summary>
        public static Vec3 ToRender(Vec3 v) => new Vec3(v.X, v.Z, v.Y);

        /// <summary>Render vector → physics vector. The map is its own inverse.</summary>
        public static Vec3 ToPhysics(Vec3 v) => new Vec3(v.X, v.Z, v.Y);

        /// <summary>A point on the cloth plane, lifted to <paramref name="height"/>.</summary>
        public static Vec3 PlaneToRender(Vec2 v, double height) => new Vec3(v.X, height, v.Y);

        /// <summary>A render-frame point projected back onto the cloth plane.</summary>
        public static Vec2 RenderToPlane(Vec3 v) => new Vec2(v.X, v.Z);

        /// <summary>Physics orientation → render orientation.</summary>
        public static Quat ToRender(Quat q) => new Quat(q.X, q.Z, q.Y, -q.W);
    }
}
