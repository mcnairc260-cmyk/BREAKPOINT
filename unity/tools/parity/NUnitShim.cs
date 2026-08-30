// A minimal stand-in for the slice of NUnit that the BREAKPOINT edit-mode tests
// use, so the *same* test files can run in two places:
//
//   • inside Unity, against the real NUnit that the Unity Test Framework ships;
//   • here, under plain Mono, with no Unity installed.
//
// That matters because the simulation is pure C# by design. Its tests should not
// need a game engine to run, and CI should not need a Unity licence to tell us
// the physics is still correct. This file is compiled ONLY by the standalone
// runner — it lives outside Assets/ so Unity never sees it and never collides
// with the real NUnit.
//
// Every member here mirrors real NUnit semantics. If a test passes against this
// shim it must pass against NUnit too; anything ambiguous is simply not
// implemented, so it fails to compile rather than behaving differently.

using System;
using System.Collections.Generic;

namespace NUnit.Framework
{
    [AttributeUsage(AttributeTargets.Class)]
    public sealed class TestFixtureAttribute : Attribute
    {
    }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class TestAttribute : Attribute
    {
    }

    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    public sealed class TestCaseAttribute : Attribute
    {
        public object[] Arguments { get; }

        public TestCaseAttribute(params object[] arguments)
        {
            Arguments = arguments;
        }
    }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class SetUpAttribute : Attribute
    {
    }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class TearDownAttribute : Attribute
    {
    }

    /// <summary>Thrown when an assertion fails. The runner catches it.</summary>
    public sealed class AssertionException : Exception
    {
        public AssertionException(string message) : base(message)
        {
        }
    }

    public static class Assert
    {
        private static string Describe(string message) =>
            string.IsNullOrEmpty(message) ? string.Empty : "  — " + message;

        public static void Fail(string message = "") =>
            throw new AssertionException("explicit failure" + Describe(message));

        public static void IsTrue(bool condition, string message = "")
        {
            if (!condition) throw new AssertionException("expected true, was false" + Describe(message));
        }

        public static void IsFalse(bool condition, string message = "")
        {
            if (condition) throw new AssertionException("expected false, was true" + Describe(message));
        }

        public static void IsNull(object value, string message = "")
        {
            if (value != null) throw new AssertionException("expected null" + Describe(message));
        }

        public static void IsNotNull(object value, string message = "")
        {
            if (value == null) throw new AssertionException("expected non-null" + Describe(message));
        }

        public static void AreEqual(double expected, double actual, double tolerance, string message = "")
        {
            if (double.IsNaN(actual) || Math.Abs(expected - actual) > tolerance)
            {
                throw new AssertionException(
                    "expected " + expected.ToString("R") + " +/- " + tolerance.ToString("R") +
                    ", was " + actual.ToString("R") + Describe(message));
            }
        }

        public static void AreSame(object expected, object actual, string message = "")
        {
            if (!ReferenceEquals(expected, actual))
            {
                throw new AssertionException("expected the same instance" + Describe(message));
            }
        }

        public static void AreEqual(long expected, long actual, string message = "")
        {
            if (expected != actual)
            {
                throw new AssertionException(
                    "expected " + expected + ", was " + actual + Describe(message));
            }
        }

        public static void AreEqual(int expected, int actual, string message = "")
        {
            if (expected != actual)
            {
                throw new AssertionException(
                    "expected " + expected + ", was " + actual + Describe(message));
            }
        }

        public static void AreEqual(bool expected, bool actual, string message = "")
        {
            if (expected != actual)
            {
                throw new AssertionException(
                    "expected " + expected + ", was " + actual + Describe(message));
            }
        }

        public static void AreEqual(string expected, string actual, string message = "")
        {
            if (!string.Equals(expected, actual, StringComparison.Ordinal))
            {
                throw new AssertionException(
                    "expected \"" + expected + "\", was \"" + actual + "\"" + Describe(message));
            }
        }

        public static void Greater(double actual, double floor, string message = "")
        {
            if (!(actual > floor))
            {
                throw new AssertionException(
                    "expected > " + floor.ToString("R") + ", was " + actual.ToString("R") + Describe(message));
            }
        }

        public static void GreaterOrEqual(double actual, double floor, string message = "")
        {
            if (!(actual >= floor))
            {
                throw new AssertionException(
                    "expected >= " + floor.ToString("R") + ", was " + actual.ToString("R") + Describe(message));
            }
        }

        public static void Less(double actual, double ceiling, string message = "")
        {
            if (!(actual < ceiling))
            {
                throw new AssertionException(
                    "expected < " + ceiling.ToString("R") + ", was " + actual.ToString("R") + Describe(message));
            }
        }

        public static void LessOrEqual(double actual, double ceiling, string message = "")
        {
            if (!(actual <= ceiling))
            {
                throw new AssertionException(
                    "expected <= " + ceiling.ToString("R") + ", was " + actual.ToString("R") + Describe(message));
            }
        }

        public static void AreEqual<T>(IReadOnlyList<T> expected, IReadOnlyList<T> actual, string message = "")
        {
            if (expected.Count != actual.Count)
            {
                throw new AssertionException(
                    "expected " + expected.Count + " items, was " + actual.Count + Describe(message));
            }

            for (int i = 0; i < expected.Count; i++)
            {
                if (!Equals(expected[i], actual[i]))
                {
                    throw new AssertionException(
                        "item " + i + ": expected " + expected[i] + ", was " + actual[i] + Describe(message));
                }
            }
        }
    }
}
