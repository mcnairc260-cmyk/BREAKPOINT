// The sliver of the UnityEditor API that BreakpointProjectSetup uses.
//
// Same purpose and same caveat as UnityApiStub.cs: this proves the setup
// script parses and names only members that exist with a compatible shape. It
// is not a Unity build, and if a signature here is wrong it agrees with the
// mistake. Read UnityApiStub.cs's header before trusting a green result.
//
// Lives outside Assets/ so Unity never sees it.

using System;

namespace UnityEngine
{
    public enum ColorSpace { Gamma, Linear }

    public class RenderPipelineAsset : ScriptableObject { }

    public static class QualitySettings
    {
        public static string[] names { get { return new string[0]; } }
        public static RenderPipelineAsset renderPipeline { get; set; }
        public static int GetQualityLevel() { return 0; }
        public static void SetQualityLevel(int index, bool applyExpensiveChanges) { }
    }
}

namespace UnityEngine.Rendering
{
    public static class GraphicsSettings
    {
        public static RenderPipelineAsset defaultRenderPipeline { get; set; }
    }
}

namespace UnityEditor
{
    public static class PlayerSettings
    {
        public static UnityEngine.ColorSpace colorSpace { get; set; }
    }

    public static class EditorApplication
    {
        public static void Exit(int returnValue) { }
    }

    public class SerializedProperty
    {
        public int intValue { get; set; }
    }

    public class SerializedObject
    {
        public SerializedObject(UnityEngine.Object target) { }
        public SerializedProperty FindProperty(string path) { return null; }
        public bool ApplyModifiedProperties() { return false; }
        public void ApplyModifiedPropertiesWithoutUndo() { }
    }

    public static class AssetDatabase
    {
        public static T LoadAssetAtPath<T>(string path) where T : UnityEngine.Object { return null; }
        public static UnityEngine.Object[] LoadAllAssetsAtPath(string path)
        {
            return new UnityEngine.Object[0];
        }
        public static void CreateAsset(UnityEngine.Object asset, string path) { }
        public static void SaveAssets() { }
        public static void Refresh() { }
    }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class MenuItem : Attribute
    {
        public MenuItem(string itemName) { }
        public MenuItem(string itemName, bool isValidateFunction, int priority) { }
    }
}
