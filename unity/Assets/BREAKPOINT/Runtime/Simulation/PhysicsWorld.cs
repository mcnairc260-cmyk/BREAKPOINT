using System;
using System.Collections.Generic;

namespace Breakpoint.Simulation
{
    /// <summary>
    /// The authoritative simulation.
    ///
    /// This type is the whole reason the Unity migration keeps a custom physics
    /// core: it is pure C# with no engine dependency, so it runs identically in
    /// an edit-mode test, in a headless parity harness, and inside a running
    /// game. Unity displays what this produces and never writes back.
    ///
    /// Two properties are load-bearing and each has a regression test:
    ///
    ///  1. **Fixed timestep.** <see cref="Step"/> always advances exactly
    ///     <see cref="PhysicsConstants.FixedDt"/> (1/120 s). Rendering runs at
    ///     whatever rate it likes and spends wall-clock time through
    ///     <see cref="FixedStepDriver"/>, so a 30 fps device and a 144 fps
    ///     device produce identical results.
    ///
    ///  2. **Continuous collision within the step.** A step is not integrated in
    ///     one go. The world repeatedly finds the earliest contact in the
    ///     remaining time, advances everything exactly to it, resolves it, and
    ///     continues. A ball at break speed covers ~10 cm per step — nearly two
    ///     ball diameters — so integrating blindly would let it pass through
    ///     another ball. Cutting the step at the contact makes tunnelling
    ///     impossible rather than unlikely.
    ///
    /// There is no randomness anywhere. Identical inputs give identical outputs.
    /// </summary>
    public sealed class PhysicsWorld
    {
        /// <summary>Cap on contact resolutions inside one 1/120 s step.</summary>
        private const int MaxSubsteps = 48;

        /// <summary>Sub-step times below this are treated as zero to avoid a stall loop.</summary>
        private const double TimeEpsilon = 1e-9;

        /// <summary>
        /// Contacts within this many seconds of each other are treated as
        /// simultaneous. At the fastest legal ball speed (12 m/s) it is a
        /// separation of 1.2 µm, four orders of magnitude below a ball radius —
        /// far too close to call an order.
        /// </summary>
        private const double SimultaneityEpsilon = 1e-7;

        /// <summary>Slack allowed when checking a batch resolution created no energy.</summary>
        private const double EnergyEpsilon = 1e-12;

        /// <summary>Relaxation passes allowed when solving a simultaneous batch.</summary>
        private const int MaxBatchPasses = 12;

        private enum ContactKind
        {
            Ball,
            Rail,
            Jaw
        }

        private struct Contact
        {
            public double Time;
            public ContactKind Kind;
            public int A;
            public int B;
            public int GeometryIndex;
        }

        private struct BodyDelta
        {
            public double Vx, Vy, Wx, Wy, Wz, Px, Py;
        }

        public readonly TableGeometry Table;

        private readonly List<BallBody> _balls = new List<BallBody>();
        private readonly List<SimEvent> _events = new List<SimEvent>();

        /// <summary>Simulated seconds since the world was created.</summary>
        public double Time { get; private set; }

        /// <summary>Set if a non-finite state was ever detected and quarantined.</summary>
        public bool Corrupted { get; private set; }

        public IReadOnlyList<BallBody> Balls => _balls;
        public IReadOnlyList<SimEvent> Events => _events;

        // --- Scratch state, reused across sub-steps -------------------------
        //
        // Contact detection runs up to MaxSubsteps times per 120 Hz step. Fresh
        // collections there would churn thousands of short-lived objects a
        // second for no benefit, so these are allocated once and cleared. They
        // are private and consumed before the next call, so reuse is safe.
        private readonly HashSet<long> _inert = new HashSet<long>();
        private readonly List<Contact> _candidates = new List<Contact>();
        private readonly List<Contact> _batch = new List<Contact>();
        private readonly List<int> _batchIndices = new List<int>();
        private readonly List<BallBody> _batchBefore = new List<BallBody>();
        private readonly List<BallBody> _batchPre = new List<BallBody>();
        private readonly List<BodyDelta> _batchDeltas = new List<BodyDelta>();
        private readonly List<double> _batchImpulses = new List<double>();
        private readonly Dictionary<int, int> _batchLoad = new Dictionary<int, int>();

        public PhysicsWorld() : this(TableGeometry.Create())
        {
        }

        public PhysicsWorld(TableGeometry table)
        {
            Table = table;
        }

        public BallBody AddBall(int number, Vec2 position)
        {
            var ball = new BallBody(_balls.Count, number, position);
            _balls.Add(ball);
            return ball;
        }

        public BallBody CueBall
        {
            get
            {
                for (int i = 0; i < _balls.Count; i++)
                {
                    if (_balls[i].Number == 0) return _balls[i];
                }
                return null;
            }
        }

        public void ClearEvents() => _events.Clear();

        /// <summary>True when nothing is moving — the shot is over and input can reopen.</summary>
        public bool IsSettled()
        {
            for (int i = 0; i < _balls.Count; i++)
            {
                if (!_balls[i].Pocketed && !_balls[i].Resting) return false;
            }
            return true;
        }

        /// <summary>Total kinetic energy, translational plus rotational.</summary>
        public double TotalEnergy()
        {
            double e = 0.0;
            for (int i = 0; i < _balls.Count; i++)
            {
                BallBody b = _balls[i];
                if (b.Pocketed) continue;
                double v2 = b.Velocity.X * b.Velocity.X + b.Velocity.Y * b.Velocity.Y;
                double w2 = b.Spin.X * b.Spin.X + b.Spin.Y * b.Spin.Y + b.Spin.Z * b.Spin.Z;
                e += 0.5 * PhysicsConstants.BallMass * v2 + 0.5 * PhysicsConstants.BallInertia * w2;
            }
            return e;
        }

        public BallBody[] Snapshot()
        {
            var copy = new BallBody[_balls.Count];
            for (int i = 0; i < _balls.Count; i++) copy[i] = _balls[i].Clone();
            return copy;
        }

        public void Restore(IReadOnlyList<BallBody> snapshot)
        {
            _balls.Clear();
            for (int i = 0; i < snapshot.Count; i++) _balls.Add(snapshot[i].Clone());
        }

        /// <summary>Advance exactly one fixed timestep.</summary>
        public void Step()
        {
            double remaining = PhysicsConstants.FixedDt;
            _inert.Clear();

            for (int iter = 0; iter < MaxSubsteps && remaining > TimeEpsilon; iter++)
            {
                List<Contact> batch = FindSimultaneousContacts(remaining);
                double dt = batch.Count > 0 ? Math.Max(batch[0].Time, 0.0) : remaining;

                if (dt > TimeEpsilon) Integrate(dt);
                remaining -= dt;

                if (batch.Count == 0) break;

                ResolveBatch(batch);
            }

            Depenetrate();
            Time += PhysicsConstants.FixedDt;
            SettleBalls();
            Sanitize();
        }

        /// <summary>
        /// Run to completion and return how long the shot took. Used by tests
        /// and the parity harness; the interactive game steps frame by frame so
        /// the player can watch.
        /// </summary>
        public double SimulateToRest(double maxSeconds = PhysicsConstants.MaxShotSeconds)
        {
            double start = Time;
            int limit = (int)Math.Ceiling(maxSeconds / PhysicsConstants.FixedDt);
            for (int i = 0; i < limit && !IsSettled(); i++) Step();
            return Time - start;
        }

        // ------------------------------------------------------------ internals

        /// <summary>
        /// Integrate positions by <paramref name="dt"/> at the current
        /// velocities — exactly the assumption the time-of-impact solver made —
        /// then apply cloth friction and roll the orientation forward.
        /// </summary>
        private void Integrate(double dt)
        {
            for (int i = 0; i < _balls.Count; i++)
            {
                BallBody b = _balls[i];
                if (b.Pocketed || b.Resting) continue;

                double px = b.Position.X;
                double py = b.Position.Y;
                b.Position = new Vec2(px + b.Velocity.X * dt, py + b.Velocity.Y * dt);

                Pocket pocket = SweptCapture(b, px, py);
                if (pocket != null)
                {
                    PocketPhysics.Capture(b, pocket);
                    _events.Add(SimEvent.PocketDrop(Time, b.Id, pocket.Id, pocket.Centre));
                    continue;
                }

                FrictionModel.Apply(b, dt);
                b.IntegrateOrientation(dt);
            }
        }

        /// <summary>
        /// Capture test swept along the ball's path this sub-step.
        ///
        /// A point test would let a ball moving 12 m/s skip straight over a
        /// 5.7 cm capture disc, so the test is against the closest approach of
        /// the segment the ball actually travelled. The final position is then
        /// checked as well, which is what catches a ball that threaded a mouth
        /// without passing close enough to the capture point.
        /// </summary>
        private Pocket SweptCapture(BallBody b, double fromX, double fromY)
        {
            double dx = b.Position.X - fromX;
            double dy = b.Position.Y - fromY;
            double lengthSquared = dx * dx + dy * dy;
            if (lengthSquared < 1e-14) return PocketPhysics.FindCapture(b, Table);

            foreach (Pocket pocket in Table.Pockets)
            {
                double t = Math.Max(0.0, Math.Min(1.0,
                    ((pocket.Centre.X - fromX) * dx + (pocket.Centre.Y - fromY) * dy) / lengthSquared));
                double cx = fromX + dx * t - pocket.Centre.X;
                double cy = fromY + dy * t - pocket.Centre.Y;
                if (cx * cx + cy * cy <= pocket.CaptureRadius * pocket.CaptureRadius) return pocket;
            }

            return PocketPhysics.FindCapture(b, Table);
        }

        /// <summary>
        /// Every contact that happens at the earliest contact time in (0, limit].
        ///
        /// Returning the whole simultaneous set rather than just the first one is
        /// what lets <see cref="ResolveBatch"/> treat them as the simultaneous
        /// event they physically are. The scan order is fixed, so the contents of
        /// the batch — and therefore the result — are deterministic.
        /// </summary>
        private List<Contact> FindSimultaneousContacts(double limit)
        {
            _candidates.Clear();
            double earliest = double.PositiveInfinity;

            int n = _balls.Count;
            for (int i = 0; i < n; i++)
            {
                BallBody a = _balls[i];
                if (a.Pocketed) continue;

                for (int j = i + 1; j < n; j++)
                {
                    BallBody b = _balls[j];
                    if (b.Pocketed) continue;
                    if (a.Resting && b.Resting) continue;

                    double? t = BallCollision.TimeOfImpact(a, b, limit);
                    if (t.HasValue)
                    {
                        Take(new Contact { Time = t.Value, Kind = ContactKind.Ball, A = i, B = j, GeometryIndex = -1 },
                            ref earliest);
                    }
                }

                if (a.Resting) continue;

                for (int r = 0; r < Table.Rails.Length; r++)
                {
                    double? t = RailCollision.RailTimeOfImpact(a, Table.Rails[r], limit);
                    if (t.HasValue)
                    {
                        Take(new Contact { Time = t.Value, Kind = ContactKind.Rail, A = i, B = -1, GeometryIndex = r },
                            ref earliest);
                    }
                }

                for (int k = 0; k < Table.Jaws.Length; k++)
                {
                    double? t = RailCollision.JawTimeOfImpact(a, Table.Jaws[k], limit);
                    if (t.HasValue)
                    {
                        Take(new Contact { Time = t.Value, Kind = ContactKind.Jaw, A = i, B = -1, GeometryIndex = k },
                            ref earliest);
                    }
                }
            }

            _batch.Clear();
            for (int i = 0; i < _candidates.Count; i++)
            {
                if (_candidates[i].Time - earliest <= SimultaneityEpsilon) _batch.Add(_candidates[i]);
            }

            return _batch;
        }

        private void Take(Contact c, ref double earliest)
        {
            if (_inert.Contains(ContactKey(c))) return;
            if (c.Time < earliest) earliest = c.Time;
            _candidates.Add(c);
        }

        /// <summary>
        /// Stable identity for a contact, used to retire inert ones within a
        /// step. Packed into a long rather than a string so the hot loop does no
        /// string formatting or allocation.
        /// </summary>
        private static long ContactKey(Contact c)
        {
            long kind = (long)c.Kind;
            long a = c.A + 1;
            long b = c.B + 1;
            long g = c.GeometryIndex + 1;
            return ((kind * 1024L + a) * 1024L + b) * 1024L + g;
        }

        /// <summary>
        /// Resolve every contact that happens at the same instant, together.
        ///
        /// A cue ball splitting a frozen pair touches both object balls at the
        /// same moment. Resolving them one after another gives the first contact
        /// a clean cue ball and the second one a cue ball that has already been
        /// deflected, so a dead-centre split squirts the cue ball sideways and
        /// the two object balls leave at different speeds — an outcome that also
        /// depends on which ball happens to sit earlier in the array. A rack is
        /// full of frozen pairs, so this fires on every break.
        ///
        /// The fix is to compute each impulse in the batch against the *same*
        /// pre-impulse state and apply the sum. Applying every full impulse at
        /// once would double-count on a ball taking several of them, so the ball
        /// is shared out between its contacts and the pass is iterated; because
        /// every pass is computed from one shared state, symmetry is preserved
        /// at every step.
        ///
        /// The iteration runs perfectly inelastically, because repeatedly
        /// applying −(1+e)·vn converges on vn = 0 whatever e is. Solving for
        /// vn = 0 exactly and then scaling the whole result by (1+e) is the
        /// standard Poisson treatment of a simultaneous impact, and for the
        /// frozen-pair case it reproduces the closed-form elastic solution.
        ///
        /// A batch that would nevertheless create energy is abandoned in favour
        /// of the sequential result: the no-energy-created invariant outranks
        /// the symmetry fix. A batch of one — overwhelmingly the common case —
        /// takes the sequential path unchanged.
        /// </summary>
        private void ResolveBatch(List<Contact> contacts)
        {
            if (contacts.Count == 1)
            {
                RetireIfInert(contacts[0], EmitResolve(contacts[0]));
                return;
            }

            _batchIndices.Clear();
            _batchLoad.Clear();
            int maxPerBody = 1;
            for (int i = 0; i < contacts.Count; i++)
            {
                Contact c = contacts[i];
                AccumulateLoad(c.A, ref maxPerBody);
                if (c.B >= 0) AccumulateLoad(c.B, ref maxPerBody);
            }

            SnapshotBatch(_batchBefore);
            double energyBefore = EnergyOf(_batchIndices);
            int eventsBefore = _events.Count;

            double relaxation = 1.0 / maxPerBody;
            _batchImpulses.Clear();
            for (int i = 0; i < contacts.Count; i++) _batchImpulses.Add(0.0);

            for (int pass = 0; pass < MaxBatchPasses; pass++)
            {
                SnapshotBatch(_batchPre);

                _batchDeltas.Clear();
                for (int i = 0; i < _batchIndices.Count; i++) _batchDeltas.Add(default(BodyDelta));

                int active = 0;
                for (int ci = 0; ci < contacts.Count; ci++)
                {
                    RestoreBodies(_batchIndices, _batchPre);
                    double impulse = ApplyContact(contacts[ci], 0.0);
                    if (impulse > 0.0)
                    {
                        active++;
                        _batchImpulses[ci] = _batchImpulses[ci] + impulse * relaxation;
                    }

                    for (int k = 0; k < _batchIndices.Count; k++)
                    {
                        BallBody now = _balls[_batchIndices[k]];
                        BallBody baseline = _batchPre[k];
                        BodyDelta d = _batchDeltas[k];
                        d.Vx += now.Velocity.X - baseline.Velocity.X;
                        d.Vy += now.Velocity.Y - baseline.Velocity.Y;
                        d.Wx += now.Spin.X - baseline.Spin.X;
                        d.Wy += now.Spin.Y - baseline.Spin.Y;
                        d.Wz += now.Spin.Z - baseline.Spin.Z;
                        d.Px += now.Position.X - baseline.Position.X;
                        d.Py += now.Position.Y - baseline.Position.Y;
                        _batchDeltas[k] = d;
                    }
                }

                RestoreBodies(_batchIndices, _batchPre);
                if (active == 0) break;

                for (int k = 0; k < _batchIndices.Count; k++)
                {
                    BallBody ball = _balls[_batchIndices[k]];
                    BodyDelta d = _batchDeltas[k];
                    ball.Velocity = new Vec2(
                        ball.Velocity.X + d.Vx * relaxation,
                        ball.Velocity.Y + d.Vy * relaxation);
                    ball.Spin = new Vec3(
                        ball.Spin.X + d.Wx * relaxation,
                        ball.Spin.Y + d.Wy * relaxation,
                        ball.Spin.Z + d.Wz * relaxation);
                    ball.Position = new Vec2(
                        ball.Position.X + d.Px * relaxation,
                        ball.Position.Y + d.Py * relaxation);
                }
            }

            // Restitution: add e times the whole inelastic result, giving (1+e)
            // times it in total. Positions are excluded — separation is
            // geometric, not an impulse, and scaling it would push balls apart
            // by more than they overlap.
            double e = BatchRestitution(contacts);
            for (int k = 0; k < _batchIndices.Count; k++)
            {
                BallBody ball = _balls[_batchIndices[k]];
                BallBody baseline = _batchBefore[k];
                double dvx = ball.Velocity.X - baseline.Velocity.X;
                double dvy = ball.Velocity.Y - baseline.Velocity.Y;
                double dwx = ball.Spin.X - baseline.Spin.X;
                double dwy = ball.Spin.Y - baseline.Spin.Y;
                double dwz = ball.Spin.Z - baseline.Spin.Z;
                ball.Velocity = new Vec2(ball.Velocity.X + dvx * e, ball.Velocity.Y + dvy * e);
                ball.Spin = new Vec3(
                    ball.Spin.X + dwx * e,
                    ball.Spin.Y + dwy * e,
                    ball.Spin.Z + dwz * e);
                if (dvx != 0.0 || dvy != 0.0 || dwx != 0.0 || dwy != 0.0 || dwz != 0.0) ball.Resting = false;
            }

            for (int i = 0; i < _batchImpulses.Count; i++) _batchImpulses[i] = _batchImpulses[i] * (1.0 + e);

            if (EnergyOf(_batchIndices) > energyBefore + EnergyEpsilon)
            {
                RestoreBodies(_batchIndices, _batchBefore);
                _events.RemoveRange(eventsBefore, _events.Count - eventsBefore);
                for (int i = 0; i < contacts.Count; i++) RetireIfInert(contacts[i], EmitResolve(contacts[i]));
                return;
            }

            for (int i = 0; i < contacts.Count; i++)
            {
                EmitContactEvent(contacts[i], _batchImpulses[i]);
                RetireIfInert(contacts[i], _batchImpulses[i]);
            }
        }

        /// <summary>
        /// Copy the batch's bodies into a scratch list, reusing the
        /// <see cref="BallBody"/> objects already in it.
        ///
        /// This is called once for the whole batch and again on every solver
        /// pass, so cloning here would allocate bodies × passes objects per
        /// simultaneous contact — and a break is nothing but simultaneous
        /// contacts. Reusing the instances makes the whole step allocation-free
        /// once the lists have grown, which is what keeps the collector out of
        /// a 120 Hz loop on a phone.
        ///
        /// The list is only ever read back at indices below
        /// <c>_batchIndices.Count</c>, so leaving stale entries beyond that is
        /// safe and is what lets the buffer stay grown between steps.
        /// </summary>
        private void SnapshotBatch(List<BallBody> into)
        {
            while (into.Count < _batchIndices.Count) into.Add(new BallBody(0, 0, Vec2.Zero));
            for (int i = 0; i < _batchIndices.Count; i++)
            {
                into[i].CopyStateFrom(_balls[_batchIndices[i]]);
            }
        }

        private void AccumulateLoad(int index, ref int maxPerBody)
        {
            if (!_batchIndices.Contains(index)) _batchIndices.Add(index);
            int count = _batchLoad.TryGetValue(index, out int existing) ? existing + 1 : 1;
            _batchLoad[index] = count;
            if (count > maxPerBody) maxPerBody = count;
        }

        /// <summary>The least elastic coefficient in a batch — the conservative choice.</summary>
        private static double BatchRestitution(List<Contact> contacts)
        {
            double e = double.PositiveInfinity;
            for (int i = 0; i < contacts.Count; i++)
            {
                double own;
                switch (contacts[i].Kind)
                {
                    case ContactKind.Ball: own = PhysicsConstants.BallRestitution; break;
                    case ContactKind.Rail: own = PhysicsConstants.RailRestitution; break;
                    default: own = PhysicsConstants.JawRestitution; break;
                }
                if (own < e) e = own;
            }
            return e;
        }

        /// <summary>
        /// A contact that produces no impulse is *inert*: geometrically touching,
        /// but not actually approaching once the contact point's own motion is
        /// taken into account (a ball held against a cushion with heavy draw is
        /// the usual case). Left in the candidate set it would be re-detected at
        /// t = 0 for the rest of the step and the loop would spin without
        /// advancing time — the balls would appear to freeze mid-table. Retiring
        /// it for the remainder of this step is what guarantees forward progress.
        /// </summary>
        private void RetireIfInert(Contact c, double impulse)
        {
            if (impulse <= 0.0) _inert.Add(ContactKey(c));
        }

        /// <summary>Kinetic energy of just the listed balls.</summary>
        private double EnergyOf(List<int> indices)
        {
            double e = 0.0;
            for (int i = 0; i < indices.Count; i++)
            {
                BallBody b = _balls[indices[i]];
                if (b.Pocketed) continue;
                double v2 = b.Velocity.X * b.Velocity.X + b.Velocity.Y * b.Velocity.Y;
                double w2 = b.Spin.X * b.Spin.X + b.Spin.Y * b.Spin.Y + b.Spin.Z * b.Spin.Z;
                e += 0.5 * PhysicsConstants.BallMass * v2 + 0.5 * PhysicsConstants.BallInertia * w2;
            }
            return e;
        }

        private void RestoreBodies(List<int> indices, List<BallBody> snapshot)
        {
            for (int k = 0; k < indices.Count; k++)
            {
                _balls[indices[k]].CopyStateFrom(snapshot[k]);
            }
        }

        /// <summary>Mutate state for one contact and return its normal impulse. No events.</summary>
        private double ApplyContact(Contact c, double restitution)
        {
            switch (c.Kind)
            {
                case ContactKind.Ball:
                    return BallCollision.Resolve(_balls[c.A], _balls[c.B], restitution);
                case ContactKind.Rail:
                    return RailCollision.ResolveRail(_balls[c.A], Table.Rails[c.GeometryIndex], restitution);
                default:
                    return RailCollision.ResolveJaw(_balls[c.A], Table.Jaws[c.GeometryIndex], restitution);
            }
        }

        /// <summary>Resolve a single contact at its real restitution and emit its event.</summary>
        private double EmitResolve(Contact c)
        {
            double impulse;
            switch (c.Kind)
            {
                case ContactKind.Ball:
                    impulse = BallCollision.Resolve(_balls[c.A], _balls[c.B]);
                    break;
                case ContactKind.Rail:
                    impulse = RailCollision.ResolveRail(_balls[c.A], Table.Rails[c.GeometryIndex]);
                    break;
                default:
                    impulse = RailCollision.ResolveJaw(_balls[c.A], Table.Jaws[c.GeometryIndex]);
                    break;
            }

            EmitContactEvent(c, impulse);
            return impulse;
        }

        private void EmitContactEvent(Contact c, double impulse)
        {
            if (impulse <= 0.0) return;

            if (c.Kind == ContactKind.Ball)
            {
                BallBody a = _balls[c.A];
                BallBody b = _balls[c.B];
                var at = new Vec2((a.Position.X + b.Position.X) / 2.0, (a.Position.Y + b.Position.Y) / 2.0);
                _events.Add(SimEvent.BallContact(Time, a.Id, b.Id, impulse, at));
                return;
            }

            BallBody ball = _balls[c.A];
            if (c.Kind == ContactKind.Rail)
            {
                _events.Add(SimEvent.RailContact(
                    Time, ball.Id, Table.Rails[c.GeometryIndex].Id, impulse, ball.Position));
                return;
            }

            _events.Add(SimEvent.JawContact(
                Time, ball.Id, Table.Jaws[c.GeometryIndex].Id, impulse, ball.Position));
        }

        /// <summary>
        /// Position-only escape hatch: push any ball that has ended the step
        /// inside a cushion or a jaw back to the surface.
        ///
        /// This is the safety net for inert contacts. A ball the impulse solver
        /// declined to act on keeps its inward velocity, so without this it would
        /// creep through the rail over successive steps. Correcting position
        /// without touching velocity cannot add energy, which is what keeps the
        /// no-energy-created guarantee intact.
        /// </summary>
        private void Depenetrate()
        {
            for (int i = 0; i < _balls.Count; i++)
            {
                BallBody ball = _balls[i];
                if (ball.Pocketed) continue;

                foreach (RailSegment rail in Table.Rails)
                {
                    if (RailCollision.RailGap(ball, rail) < 0.0 && RailCollision.WithinRailSpan(ball, rail))
                    {
                        RailCollision.DepenetrateRail(ball, rail);
                    }
                }

                foreach (Jaw jaw in Table.Jaws)
                {
                    RailCollision.DepenetrateJaw(ball, jaw);
                }
            }
        }

        /// <summary>Snap balls below the rest thresholds to exact zero, and emit 'rest' once.</summary>
        private void SettleBalls()
        {
            bool wasSettled = IsSettled();

            for (int i = 0; i < _balls.Count; i++)
            {
                BallBody b = _balls[i];
                if (b.Pocketed || b.Resting) continue;
                if (b.BelowRestThreshold()) b.ForceRest();
            }

            if (!wasSettled && IsSettled()) _events.Add(SimEvent.Rest(Time));
        }

        /// <summary>
        /// The NaN/Infinity tripwire.
        ///
        /// Nothing in the model should produce a non-finite value — every
        /// normalisation guards its divisor and every friction term is clamped —
        /// but a physics core that silently poisons the whole table is far worse
        /// than one that stops a single ball, so the state is checked every step
        /// and any bad ball is frozen rather than allowed to spread NaN through
        /// a collision.
        /// </summary>
        private void Sanitize()
        {
            for (int i = 0; i < _balls.Count; i++)
            {
                BallBody b = _balls[i];
                if (b.IsFinite) continue;

                Corrupted = true;
                double x = Numeric.IsFinite(b.Position.X) ? b.Position.X : 0.0;
                double y = Numeric.IsFinite(b.Position.Y) ? b.Position.Y : 0.0;
                b.Position = new Vec2(x, y);
                b.ForceRest();
            }
        }
    }
}
