// The sliver of UnityEngine.TestTools the play-mode tests use.
//
// The play-mode tests cannot be *run* without Unity — they need a player loop,
// which is the whole reason they are play-mode tests. They can still be
// shape-checked, and that is worth doing: without it they would be the only
// code in the project never seen by any compiler, and a syntax error in them
// would not surface until someone opened the editor.
//
// Lives outside Assets/ so Unity never sees it.

using System;

namespace UnityEngine.TestTools
{
    /// <summary>
    /// Marks a coroutine test. Real NUnit runs it through Unity's player loop;
    /// nothing here runs it at all.
    /// </summary>
    [AttributeUsage(AttributeTargets.Method)]
    public sealed class UnityTestAttribute : Attribute
    {
    }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class UnitySetUpAttribute : Attribute
    {
    }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class UnityTearDownAttribute : Attribute
    {
    }
}
