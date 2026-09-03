using System;
using System.IO;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace Breakpoint.EditorTools
{
    /// <summary>
    /// Applies the four project settings BREAKPOINT needs on a fresh checkout.
    ///
    /// These are not committed. `ProjectSettings.asset` and `QualitySettings.asset`
    /// are Unity's own serialised files, and hand-writing them without an editor
    /// risks producing a project that will not open at all — so the repository
    /// ships the *intent* as code and lets Unity apply it. See
    /// docs/BREAKPOINT_UNITY_MIGRATION.md §9.
    ///
    /// Run it from the editor (BREAKPOINT ▸ Apply project setup) or headlessly:
    ///
    ///   Unity -batchmode -quit -projectPath unity \
    ///         -executeMethod Breakpoint.EditorTools.BreakpointProjectSetup.Run
    ///
    /// Every step reports what it did. A step that cannot complete fails the run
    /// rather than logging a warning and carrying on: a half-configured project
    /// renders wrongly in ways that look like art bugs, and chasing one of those
    /// costs far more than a red exit code.
    /// </summary>
    public static class BreakpointProjectSetup
    {
        private const string ExpectedVersion = "6000.0.23f1";
        private const string RenderPipelineDirectory = "Assets/BREAKPOINT/Rendering";
        private const string PipelineAssetPath = RenderPipelineDirectory + "/BreakpointURP.asset";
        private const string RendererAssetPath = RenderPipelineDirectory + "/BreakpointRenderer.asset";

        /// <summary>Input Manager (Old). See <see cref="ApplyInputHandler"/>.</summary>
        private const int LegacyInputHandler = 0;

        [MenuItem("BREAKPOINT/Apply project setup")]
        public static void RunFromMenu()
        {
            if (Apply(out string error)) Debug.Log("BREAKPOINT: project setup complete.");
            else Debug.LogError("BREAKPOINT: project setup failed — " + error);
        }

        /// <summary>Batch-mode entry point. Exits non-zero on any failure.</summary>
        public static void Run()
        {
            string error;
            bool ok = Apply(out error);

            if (ok)
            {
                Debug.Log("BREAKPOINT_SETUP_RESULT: OK");
                EditorApplication.Exit(0);
                return;
            }

            Debug.LogError("BREAKPOINT_SETUP_RESULT: FAILED — " + error);
            EditorApplication.Exit(1);
        }

        private static bool Apply(out string error)
        {
            error = null;

            ReportVersion();

            ApplyColorSpace();

            if (!ApplyRenderPipeline(out error)) return false;

            ApplyInputHandler();

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            return true;
        }

        // ---------------------------------------------------------------- steps

        /// <summary>
        /// The version is reported, not enforced. A newer patch release is
        /// usually fine and refusing to run on one would be more obstructive
        /// than useful — but a mismatch is worth seeing in the log when
        /// something later behaves oddly.
        /// </summary>
        private static void ReportVersion()
        {
            string actual = Application.unityVersion;
            if (actual == ExpectedVersion)
            {
                Debug.Log("BREAKPOINT: Unity " + actual + " (as pinned).");
            }
            else
            {
                Debug.LogWarning(
                    "BREAKPOINT: running Unity " + actual + ", but ProjectVersion.txt pins " +
                    ExpectedVersion + ". Continuing.");
            }
        }

        /// <summary>
        /// URP's lighting model assumes linear colour. In gamma the low-key
        /// single-lamp look the art direction asks for goes muddy, and every
        /// material value in the project would have to be re-tuned around the
        /// wrong response curve.
        /// </summary>
        private static void ApplyColorSpace()
        {
            if (PlayerSettings.colorSpace == ColorSpace.Linear)
            {
                Debug.Log("BREAKPOINT: colour space already Linear.");
                return;
            }

            PlayerSettings.colorSpace = ColorSpace.Linear;
            Debug.Log("BREAKPOINT: colour space set to Linear.");
        }

        /// <summary>
        /// Create a URP asset if the project has none, then assign it both as
        /// the default pipeline and on every quality level. Missing either
        /// assignment leaves some cameras on the built-in pipeline, which shows
        /// up as materials rendering pink in one quality tier only.
        /// </summary>
        private static bool ApplyRenderPipeline(out string error)
        {
            error = null;

            RenderPipelineAsset existing = GraphicsSettings.defaultRenderPipeline;
            if (existing != null)
            {
                Debug.Log("BREAKPOINT: render pipeline already assigned (" + existing.name + ").");
                AssignToAllQualityLevels(existing);
                return true;
            }

            RenderPipelineAsset asset = AssetDatabase.LoadAssetAtPath<RenderPipelineAsset>(PipelineAssetPath);
            if (asset == null)
            {
                asset = CreatePipelineAsset(out error);
                if (asset == null) return false;
            }

            GraphicsSettings.defaultRenderPipeline = asset;
            AssignToAllQualityLevels(asset);
            Debug.Log("BREAKPOINT: URP asset created and assigned at " + PipelineAssetPath + ".");
            return true;
        }

        /// <summary>
        /// Build the pipeline asset through URP's own factory.
        ///
        /// Reached by reflection on purpose: the exact signature of
        /// <c>UniversalRenderPipelineAsset.Create</c> has moved between URP
        /// major versions, and a hard reference would make this script fail to
        /// compile on a version it could otherwise have configured perfectly.
        /// </summary>
        private static RenderPipelineAsset CreatePipelineAsset(out string error)
        {
            error = null;
            Directory.CreateDirectory(RenderPipelineDirectory);

            Type rendererDataType = FindType("UnityEngine.Rendering.Universal.UniversalRendererData");
            Type pipelineType = FindType("UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset");

            if (rendererDataType == null || pipelineType == null)
            {
                error = "the Universal Render Pipeline package is not installed " +
                        "(UniversalRendererData / UniversalRenderPipelineAsset not found). " +
                        "Install com.unity.render-pipelines.universal and re-run.";
                return null;
            }

            var rendererData = ScriptableObject.CreateInstance(rendererDataType);
            if (rendererData == null)
            {
                error = "could not instantiate UniversalRendererData.";
                return null;
            }

            AssetDatabase.CreateAsset(rendererData, RendererAssetPath);

            MethodInfo create = null;
            foreach (MethodInfo m in pipelineType.GetMethods(BindingFlags.Public | BindingFlags.Static))
            {
                if (m.Name != "Create") continue;
                ParameterInfo[] p = m.GetParameters();
                if (p.Length >= 1 && p[0].ParameterType.IsInstanceOfType(rendererData))
                {
                    create = m;
                    break;
                }
            }

            if (create == null)
            {
                error = "UniversalRenderPipelineAsset.Create(rendererData) not found on this URP version. " +
                        "Create a URP asset by hand (Assets ▸ Create ▸ Rendering ▸ URP Asset), " +
                        "assign it in Graphics and Quality settings, and re-run.";
                return null;
            }

            object[] args = create.GetParameters().Length == 1
                ? new object[] { rendererData }
                : new object[] { rendererData, false };

            var asset = create.Invoke(null, args) as RenderPipelineAsset;
            if (asset == null)
            {
                error = "UniversalRenderPipelineAsset.Create returned null.";
                return null;
            }

            AssetDatabase.CreateAsset(asset, PipelineAssetPath);
            AssetDatabase.SaveAssets();
            return asset;
        }

        private static void AssignToAllQualityLevels(RenderPipelineAsset asset)
        {
            int previous = QualitySettings.GetQualityLevel();
            string[] names = QualitySettings.names;

            for (int i = 0; i < names.Length; i++)
            {
                QualitySettings.SetQualityLevel(i, false);
                if (QualitySettings.renderPipeline != asset) QualitySettings.renderPipeline = asset;
            }

            QualitySettings.SetQualityLevel(previous, false);
            Debug.Log("BREAKPOINT: URP assigned across " + names.Length + " quality level(s).");
        }

        /// <summary>
        /// Phase A uses the legacy Input class deliberately: one code path
        /// handles mouse, touch and pen identically, which is the requirement.
        /// The setting lives only in the serialised project settings, so it has
        /// to be reached through SerializedObject rather than a typed API.
        ///
        /// Unity applies this on the next editor launch, which is why the
        /// verification script runs the editor twice.
        /// </summary>
        private static void ApplyInputHandler()
        {
            UnityEngine.Object[] settings =
                AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/ProjectSettings.asset");

            if (settings == null || settings.Length == 0)
            {
                Debug.LogWarning("BREAKPOINT: ProjectSettings.asset not readable; input handling left as-is.");
                return;
            }

            var serialized = new SerializedObject(settings[0]);
            SerializedProperty handler = serialized.FindProperty("activeInputHandler");

            if (handler == null)
            {
                Debug.LogWarning("BREAKPOINT: activeInputHandler not found; input handling left as-is.");
                return;
            }

            if (handler.intValue == LegacyInputHandler)
            {
                Debug.Log("BREAKPOINT: input handling already Input Manager (Old).");
                return;
            }

            handler.intValue = LegacyInputHandler;
            serialized.ApplyModifiedPropertiesWithoutUndo();
            Debug.Log("BREAKPOINT: input handling set to Input Manager (Old) — takes effect next launch.");
        }

        private static Type FindType(string fullName)
        {
            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type found = assembly.GetType(fullName, false);
                if (found != null) return found;
            }
            return null;
        }
    }
}
