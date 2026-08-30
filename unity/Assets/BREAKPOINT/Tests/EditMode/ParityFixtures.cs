using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace Breakpoint.Tests
{
    /// <summary>One recorded event from the reference implementation.</summary>
    public struct FixtureEvent
    {
        public string Type;
        public int BallA;
        public int BallB;
        public string GeometryId;
        public double Impulse;
    }

    /// <summary>A ball's starting placement in a fixture.</summary>
    public struct FixtureBall
    {
        public int Number;
        public double X;
        public double Y;
    }

    /// <summary>A directly seeded velocity and spin, for fixtures with no cue strike.</summary>
    public struct FixtureSeed
    {
        public int Number;
        public double Vx;
        public double Vy;
        public double Wx;
        public double Wy;
        public double Wz;
    }

    /// <summary>One ball's recorded final state.</summary>
    public struct FixtureFinal
    {
        public int Number;
        public double X;
        public double Y;
        public bool Pocketed;
        public string PocketId;
    }

    /// <summary>
    /// A canonical shot, as the TypeScript reference implementation resolved it.
    ///
    /// These are the behavioural specification for the C# port. They are not
    /// expectations invented for the port; they are what the validated oracle
    /// actually produced, written down.
    /// </summary>
    public sealed class ParityFixture
    {
        public string Name;
        public string Covers;
        public List<FixtureBall> Balls = new List<FixtureBall>();
        public List<FixtureSeed> Seeds = new List<FixtureSeed>();
        public bool HasStrike;
        public double AimAngle;
        public double Speed;
        public double TipX;
        public double TipY;
        public List<FixtureEvent> Events = new List<FixtureEvent>();
        public List<FixtureFinal> Finals = new List<FixtureFinal>();
        public double Duration;
        public int Steps;
        public bool Settled;
        public bool Corrupted;
    }

    /// <summary>
    /// Loads the parity fixture file.
    ///
    /// The format is flat text on purpose: no JSON dependency is needed on
    /// either side, it diffs legibly in review, and a changed physics number
    /// shows up as a changed line in a pull request rather than hiding inside a
    /// blob.
    /// </summary>
    public static class ParityFixtures
    {
        private const string FileName = "parity.txt";

        private static List<ParityFixture> _cache;

        public static IReadOnlyList<ParityFixture> All()
        {
            if (_cache != null) return _cache;
            _cache = Parse(File.ReadAllLines(Locate()));
            return _cache;
        }

        public static ParityFixture ByName(string name)
        {
            foreach (ParityFixture fixture in All())
            {
                if (fixture.Name == name) return fixture;
            }

            throw new InvalidDataException("no parity fixture named '" + name + "'");
        }

        /// <summary>
        /// Find the fixture file without assuming a working directory.
        ///
        /// Unity runs edit-mode tests from the project root; the standalone Mono
        /// runner may be invoked from anywhere. An explicit override wins, then
        /// a walk up from the current directory, so both work with no
        /// configuration.
        /// </summary>
        private static string Locate()
        {
            string configured = Environment.GetEnvironmentVariable("BREAKPOINT_FIXTURES");
            if (!string.IsNullOrEmpty(configured))
            {
                string direct = Directory.Exists(configured)
                    ? Path.Combine(configured, FileName)
                    : configured;
                if (File.Exists(direct)) return direct;
            }

            string relative = Path.Combine(
                "Assets", "BREAKPOINT", "Tests", "EditMode", "Fixtures", FileName);

            var directory = new DirectoryInfo(Directory.GetCurrentDirectory());
            while (directory != null)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate)) return candidate;
                directory = directory.Parent;
            }

            throw new FileNotFoundException(
                "could not find " + relative +
                " by walking up from " + Directory.GetCurrentDirectory() +
                "; set BREAKPOINT_FIXTURES to point at it");
        }

        private static double Num(string token) =>
            double.Parse(token, NumberStyles.Float, CultureInfo.InvariantCulture);

        private static List<ParityFixture> Parse(string[] lines)
        {
            var fixtures = new List<ParityFixture>();
            ParityFixture current = null;

            foreach (string raw in lines)
            {
                string line = raw.Trim();
                if (line.Length == 0 || line[0] == '#') continue;

                string[] parts = line.Split(' ');
                switch (parts[0])
                {
                    case "fixture":
                        current = new ParityFixture { Name = parts[1] };
                        break;

                    case "covers":
                        current.Covers = line.Substring("covers ".Length);
                        break;

                    case "ball":
                        current.Balls.Add(new FixtureBall
                        {
                            Number = int.Parse(parts[1]),
                            X = Num(parts[2]),
                            Y = Num(parts[3]),
                        });
                        break;

                    case "seed":
                        current.Seeds.Add(new FixtureSeed
                        {
                            Number = int.Parse(parts[1]),
                            Vx = Num(parts[2]),
                            Vy = Num(parts[3]),
                            Wx = Num(parts[4]),
                            Wy = Num(parts[5]),
                            Wz = Num(parts[6]),
                        });
                        break;

                    case "strike":
                        current.HasStrike = true;
                        current.AimAngle = Num(parts[1]);
                        current.Speed = Num(parts[2]);
                        current.TipX = Num(parts[3]);
                        current.TipY = Num(parts[4]);
                        break;

                    case "event":
                        current.Events.Add(new FixtureEvent
                        {
                            Type = parts[1],
                            BallA = int.Parse(parts[2]),
                            BallB = int.Parse(parts[3]),
                            GeometryId = parts[4] == "-" ? null : parts[4],
                            Impulse = Num(parts[5]),
                        });
                        break;

                    case "final":
                        current.Finals.Add(new FixtureFinal
                        {
                            Number = int.Parse(parts[1]),
                            X = Num(parts[2]),
                            Y = Num(parts[3]),
                            Pocketed = parts[4] == "1",
                            PocketId = parts[5] == "-" ? null : parts[5],
                        });
                        break;

                    case "duration":
                        current.Duration = Num(parts[1]);
                        break;

                    case "steps":
                        current.Steps = int.Parse(parts[1]);
                        break;

                    case "settled":
                        current.Settled = parts[1] == "1";
                        break;

                    case "corrupted":
                        current.Corrupted = parts[1] == "1";
                        break;

                    case "end":
                        fixtures.Add(current);
                        current = null;
                        break;

                    default:
                        throw new InvalidDataException("unrecognised fixture directive: " + parts[0]);
                }
            }

            return fixtures;
        }
    }
}
