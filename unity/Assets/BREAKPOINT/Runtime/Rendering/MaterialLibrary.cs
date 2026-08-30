using System.Collections.Generic;
using UnityEngine;

namespace Breakpoint.Rendering
{
    /// <summary>
    /// Runtime materials for the scene, built once and shared.
    ///
    /// Everything is constructed in code rather than authored as assets. That
    /// is a deliberate stage-one choice, not a final one: it means the first
    /// scene can be built and reviewed before any art exists, and it gives the
    /// production art pass (see BREAKPOINT_VISUAL_ASSET_MANIFEST.md) a working
    /// target to replace piece by piece rather than a blank project.
    ///
    /// Materials are cached and disposed with the library so a scene reload
    /// does not leak them — the TypeScript reference had exactly that leak
    /// before it was fixed, and it is cheaper to avoid here than to find later.
    /// </summary>
    public sealed class MaterialLibrary : System.IDisposable
    {
        private const string LitShader = "Universal Render Pipeline/Lit";
        private const string UnlitShader = "Universal Render Pipeline/Unlit";

        private readonly List<Object> _owned = new List<Object>();
        private readonly Dictionary<int, Material> _balls = new Dictionary<int, Material>();
        private readonly Shader _lit;
        private readonly Shader _unlit;

        public MaterialLibrary()
        {
            _lit = Shader.Find(LitShader);
            _unlit = Shader.Find(UnlitShader);

            if (_lit == null)
            {
                // Falling back keeps the scene visible instead of magenta, but
                // it is a real misconfiguration and must not pass silently.
                Debug.LogError(
                    "BREAKPOINT: '" + LitShader + "' not found. The Universal Render Pipeline " +
                    "package is missing or no URP asset is assigned in Graphics settings. " +
                    "Falling back to the built-in standard shader; lighting will not match the " +
                    "art direction.");
                _lit = Shader.Find("Standard");
            }

            if (_unlit == null) _unlit = Shader.Find("Unlit/Color");
        }

        /// <summary>The albedo-mapped, slightly glossy material for one ball.</summary>
        public Material Ball(int number)
        {
            Material existing;
            if (_balls.TryGetValue(number, out existing)) return existing;

            Texture2D albedo = BallTextureFactory.Create(number);
            _owned.Add(albedo);

            var material = new Material(_lit) { name = "Ball_" + number };
            SetTexture(material, albedo);
            // Phenolic resin: near-mirror at grazing angles, no metal.
            SetFloat(material, "_Smoothness", 0.93f);
            SetFloat(material, "_Metallic", 0f);
            Track(material);

            _balls[number] = material;
            return material;
        }

        /// <summary>A plain lit surface.</summary>
        public Material Surface(string name, Color color, float smoothness, float metallic)
        {
            var material = new Material(_lit) { name = name };
            SetColor(material, color);
            SetFloat(material, "_Smoothness", smoothness);
            SetFloat(material, "_Metallic", metallic);
            return Track(material);
        }

        /// <summary>An unlit surface, for overlay lines and the pocket voids.</summary>
        public Material Flat(string name, Color color)
        {
            var material = new Material(_unlit) { name = name };
            SetColor(material, color);
            if (color.a < 1f) MakeTransparent(material);
            return Track(material);
        }

        private static void MakeTransparent(Material material)
        {
            material.SetFloat("_Surface", 1f);
            material.SetFloat("_Blend", 0f);
            material.SetFloat("_ZWrite", 0f);
            material.SetInt("_SrcBlend", (int)UnityEngine.Rendering.BlendMode.SrcAlpha);
            material.SetInt("_DstBlend", (int)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
            material.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
            material.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
        }

        // URP and the built-in pipeline disagree on property names, and the
        // fallback path above can land on either. Setting both is cheaper than
        // branching on which shader was found.
        private static void SetColor(Material material, Color color)
        {
            if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", color);
            if (material.HasProperty("_Color")) material.SetColor("_Color", color);
        }

        private static void SetTexture(Material material, Texture texture)
        {
            if (material.HasProperty("_BaseMap")) material.SetTexture("_BaseMap", texture);
            if (material.HasProperty("_MainTex")) material.SetTexture("_MainTex", texture);
        }

        private static void SetFloat(Material material, string name, float value)
        {
            if (material.HasProperty(name)) material.SetFloat(name, value);
            if (name == "_Smoothness" && material.HasProperty("_Glossiness"))
            {
                material.SetFloat("_Glossiness", value);
            }
        }

        private Material Track(Material material)
        {
            _owned.Add(material);
            return material;
        }

        public void Dispose()
        {
            for (int i = 0; i < _owned.Count; i++)
            {
                if (_owned[i] == null) continue;
                if (Application.isPlaying) Object.Destroy(_owned[i]);
                else Object.DestroyImmediate(_owned[i]);
            }
            _owned.Clear();
            _balls.Clear();
        }
    }
}
