// Standalone runner for the BREAKPOINT edit-mode tests.
//
// Discovers every [Test] and [TestCase] method on every [TestFixture] class by
// reflection — the same shapes the Unity Test Framework discovers — and runs
// them. Exists so the physics suite can run in CI, and on a developer machine,
// without a Unity installation or licence.
//
// Exit code is 0 only if every test passed, so it works as a CI gate.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using NUnit.Framework;

namespace Breakpoint.TestRunner
{
    public static class Program
    {
        public static int Main(string[] args)
        {
            bool verbose = args.Contains("--verbose");
            string filter = args.FirstOrDefault(a => a.StartsWith("--filter=", StringComparison.Ordinal))
                ?.Substring("--filter=".Length);

            var fixtures = Assembly.GetExecutingAssembly()
                .GetTypes()
                .Where(t => t.GetCustomAttribute<TestFixtureAttribute>() != null)
                .OrderBy(t => t.FullName, StringComparer.Ordinal)
                .ToList();

            int passed = 0;
            int failed = 0;
            var failures = new List<string>();
            var stopwatch = Stopwatch.StartNew();

            foreach (Type fixture in fixtures)
            {
                object instance = Activator.CreateInstance(fixture);
                var methods = fixture.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                    .Where(m => m.GetCustomAttribute<TestAttribute>() != null
                        || m.GetCustomAttributes<TestCaseAttribute>().Any())
                    .OrderBy(m => m.Name, StringComparer.Ordinal)
                    .ToList();

                foreach (MethodInfo method in methods)
                {
                    var cases = method.GetCustomAttributes<TestCaseAttribute>().ToList();
                    if (cases.Count == 0)
                    {
                        RunOne(instance, method, null, fixture, filter, verbose,
                            ref passed, ref failed, failures);
                    }
                    else
                    {
                        foreach (TestCaseAttribute testCase in cases)
                        {
                            RunOne(instance, method, testCase.Arguments, fixture, filter, verbose,
                                ref passed, ref failed, failures);
                        }
                    }
                }
            }

            stopwatch.Stop();
            Console.WriteLine();
            Console.WriteLine("================================================");
            Console.WriteLine(
                "  " + (passed + failed) + " tests, " + passed + " passed, " + failed + " failed" +
                "  (" + stopwatch.ElapsedMilliseconds + " ms)");
            if (failures.Count > 0)
            {
                Console.WriteLine();
                foreach (string failure in failures) Console.WriteLine("  FAIL " + failure);
            }
            Console.WriteLine("================================================");

            return failed == 0 ? 0 : 1;
        }

        private static void RunOne(
            object instance,
            MethodInfo method,
            object[] arguments,
            Type fixture,
            string filter,
            bool verbose,
            ref int passed,
            ref int failed,
            List<string> failures)
        {
            string label = fixture.Name + "." + method.Name;
            if (arguments != null) label += "(" + string.Join(", ", arguments.Select(a => a?.ToString() ?? "null")) + ")";
            if (filter != null && label.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) return;

            try
            {
                // Coerce ints to doubles where the parameter asks for one, which
                // is what NUnit does for a [TestCase(3)] on a double parameter.
                object[] call = arguments;
                if (arguments != null)
                {
                    ParameterInfo[] parameters = method.GetParameters();
                    call = new object[arguments.Length];
                    for (int i = 0; i < arguments.Length; i++)
                    {
                        call[i] = Convert.ChangeType(arguments[i], parameters[i].ParameterType);
                    }
                }

                method.Invoke(instance, call);
                passed++;
                if (verbose) Console.WriteLine("  ok   " + label);
            }
            catch (TargetInvocationException e)
            {
                failed++;
                Exception inner = e.InnerException ?? e;
                string detail = inner is AssertionException ? inner.Message : inner.ToString();
                failures.Add(label + "\n         " + detail);
                Console.WriteLine("  FAIL " + label);
            }
        }
    }
}
