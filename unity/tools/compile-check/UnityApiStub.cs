// A hand-written stub of the small slice of the Unity API that BREAKPOINT's
// presentation, rendering, input and UI code touches.
//
// WHY THIS EXISTS
//
// Unity cannot be installed in every environment this project is worked in —
// it needs a licensed editor, and on a headless machine behind a restrictive
// proxy it may not be obtainable at all. Without it, roughly fifteen hundred
// lines of Unity-facing C# would ship having never been near a compiler.
//
// Compiling against this stub does not prove the code *works*. It proves the
// code parses, that every type and member it names exists with a compatible
// shape, that no `using` is missing, and that nothing was left half-edited.
// That is a large fraction of the mistakes a first Unity compile would catch,
// and it costs nothing to check on every change.
//
// WHAT IT DOES NOT PROVE
//
// The signatures here were written from knowledge of the Unity API, not
// generated from it. If one of them is wrong, this file agrees with the
// mistake. It is therefore a lower bound on correctness, never a substitute
// for opening the project — see docs/BREAKPOINT_UNITY_MIGRATION.md, "Test
// status", which records the Unity compile as NOT executed regardless of
// whether this check is green.
//
// It lives outside Assets/ so Unity never sees it.

using System;

namespace UnityEngine
{
    public struct Vector2
    {
        public float x, y;
        public Vector2(float x, float y) { this.x = x; this.y = y; }
        public float magnitude { get { return Mathf.Sqrt(x * x + y * y); } }
        public Vector2 normalized { get { float m = magnitude; return m > 0f ? this / m : zero; } }
        public static Vector2 zero { get { return new Vector2(0f, 0f); } }
        public static Vector2 one { get { return new Vector2(1f, 1f); } }
        public static Vector2 operator +(Vector2 a, Vector2 b) { return new Vector2(a.x + b.x, a.y + b.y); }
        public static Vector2 operator -(Vector2 a, Vector2 b) { return new Vector2(a.x - b.x, a.y - b.y); }
        public static Vector2 operator *(Vector2 a, float s) { return new Vector2(a.x * s, a.y * s); }
        public static Vector2 operator /(Vector2 a, float s) { return new Vector2(a.x / s, a.y / s); }
        public static implicit operator Vector2(Vector3 v) { return new Vector2(v.x, v.y); }
    }

    public struct Vector3
    {
        public float x, y, z;
        public Vector3(float x, float y, float z) { this.x = x; this.y = y; this.z = z; }
        public float magnitude { get { return Mathf.Sqrt(x * x + y * y + z * z); } }
        public Vector3 normalized { get { float m = magnitude; return m > 0f ? this / m : zero; } }
        public static Vector3 zero { get { return new Vector3(0f, 0f, 0f); } }
        public static Vector3 one { get { return new Vector3(1f, 1f, 1f); } }
        public static Vector3 up { get { return new Vector3(0f, 1f, 0f); } }
        public static Vector3 Lerp(Vector3 a, Vector3 b, float t) { return a + (b - a) * t; }
        public static Vector3 Cross(Vector3 a, Vector3 b)
        {
            return new Vector3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
        }
        public static Vector3 operator +(Vector3 a, Vector3 b) { return new Vector3(a.x + b.x, a.y + b.y, a.z + b.z); }
        public static Vector3 operator -(Vector3 a, Vector3 b) { return new Vector3(a.x - b.x, a.y - b.y, a.z - b.z); }
        public static Vector3 operator -(Vector3 a) { return new Vector3(-a.x, -a.y, -a.z); }
        public static Vector3 operator *(Vector3 a, float s) { return new Vector3(a.x * s, a.y * s, a.z * s); }
        public static Vector3 operator /(Vector3 a, float s) { return new Vector3(a.x / s, a.y / s, a.z / s); }
        public static implicit operator Vector3(Vector2 v) { return new Vector3(v.x, v.y, 0f); }
    }

    public struct Quaternion
    {
        public float x, y, z, w;
        public Quaternion(float x, float y, float z, float w) { this.x = x; this.y = y; this.z = z; this.w = w; }
        public static Quaternion identity { get { return new Quaternion(0f, 0f, 0f, 1f); } }
        public static Quaternion Euler(float x, float y, float z) { return identity; }
        public static Quaternion LookRotation(Vector3 forward) { return identity; }
        public static Quaternion LookRotation(Vector3 forward, Vector3 up) { return identity; }
    }

    public struct Color
    {
        public float r, g, b, a;
        public Color(float r, float g, float b) { this.r = r; this.g = g; this.b = b; this.a = 1f; }
        public Color(float r, float g, float b, float a) { this.r = r; this.g = g; this.b = b; this.a = a; }
        public static Color white { get { return new Color(1f, 1f, 1f, 1f); } }
        public static Color black { get { return new Color(0f, 0f, 0f, 1f); } }
        public static Color operator *(Color c, float s) { return new Color(c.r * s, c.g * s, c.b * s, c.a); }
        public static implicit operator Color(Color32 c)
        {
            return new Color(c.r / 255f, c.g / 255f, c.b / 255f, c.a / 255f);
        }
    }

    public struct Color32
    {
        public byte r, g, b, a;
        public Color32(byte r, byte g, byte b, byte a) { this.r = r; this.g = g; this.b = b; this.a = a; }
        public static Color32 Lerp(Color32 a, Color32 b, float t) { return t < 0.5f ? a : b; }
        public static implicit operator Color32(Color c)
        {
            return new Color32((byte)(c.r * 255), (byte)(c.g * 255), (byte)(c.b * 255), (byte)(c.a * 255));
        }
    }

    public static class Mathf
    {
        public const float PI = 3.14159274f;
        public const float Deg2Rad = 0.0174532924f;
        public const float Rad2Deg = 57.29578f;
        public static float Sqrt(float v) { return (float)Math.Sqrt(v); }
        public static float Sin(float v) { return (float)Math.Sin(v); }
        public static float Cos(float v) { return (float)Math.Cos(v); }
        public static float Tan(float v) { return (float)Math.Tan(v); }
        public static float Atan2(float y, float x) { return (float)Math.Atan2(y, x); }
        public static float Exp(float v) { return (float)Math.Exp(v); }
        public static float Abs(float v) { return Math.Abs(v); }
        public static float Min(float a, float b) { return Math.Min(a, b); }
        public static int Min(int a, int b) { return Math.Min(a, b); }
        public static float Max(float a, float b) { return Math.Max(a, b); }
        public static int Max(int a, int b) { return Math.Max(a, b); }
        public static float Clamp(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
        public static int Clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
        public static float Clamp01(float v) { return Clamp(v, 0f, 1f); }
        public static int RoundToInt(float v) { return (int)Math.Round(v); }
        public static int FloorToInt(float v) { return (int)Math.Floor(v); }
        public static int CeilToInt(float v) { return (int)Math.Ceiling(v); }
    }

    public class Object
    {
        public string name;
        public HideFlags hideFlags;
        public static void Destroy(Object o) { }
        public static void DestroyImmediate(Object o) { }
        public static bool operator ==(Object a, Object b) { return ReferenceEquals(a, b); }
        public static bool operator !=(Object a, Object b) { return !ReferenceEquals(a, b); }
        public override bool Equals(object o) { return ReferenceEquals(this, o); }
        public override int GetHashCode() { return base.GetHashCode(); }
    }

    public enum HideFlags { None = 0 }

    public class Component : Object
    {
        public GameObject gameObject { get { return null; } }
        public Transform transform { get { return null; } }
        public T GetComponent<T>() where T : class { return null; }
        public T GetComponentInParent<T>() where T : class { return null; }
        public T[] GetComponentsInChildren<T>(bool includeInactive) where T : class { return new T[0]; }
        public T GetComponentInChildren<T>() where T : class { return null; }
    }

    public class Behaviour : Component { public bool enabled; }

    public class MonoBehaviour : Behaviour { }

    public class ScriptableObject : Object
    {
        public static T CreateInstance<T>() where T : ScriptableObject { return null; }
        public static ScriptableObject CreateInstance(System.Type type) { return null; }
    }

    public enum PrimitiveType { Sphere, Cube, Cylinder, Capsule, Plane, Quad }

    public class GameObject : Object
    {
        public string tag;
        public Transform transform { get { return null; } }
        public GameObject() { }
        public GameObject(string name) { this.name = name; }
        public GameObject(string name, params Type[] components) { this.name = name; }
        public T AddComponent<T>() where T : Component { return null; }
        public T GetComponent<T>() where T : class { return null; }
        public T[] GetComponentsInChildren<T>(bool includeInactive) where T : class { return new T[0]; }
        public T GetComponentInChildren<T>() where T : class { return null; }
        public bool activeSelf { get { return true; } }
        public void SetActive(bool value) { }
        public static GameObject CreatePrimitive(PrimitiveType type) { return null; }
    }

    public class Transform : Component, System.Collections.IEnumerable
    {
        public Vector3 position { get; set; }
        public Vector3 localPosition { get; set; }
        public Vector3 localScale { get; set; }
        public Quaternion rotation { get; set; }
        public Quaternion localRotation { get; set; }
        public int childCount { get { return 0; } }
        public Transform GetChild(int index) { return null; }
        public void SetParent(Transform parent, bool worldPositionStays) { }
        public System.Collections.IEnumerator GetEnumerator() { yield break; }
    }

    public class RectTransform : Transform
    {
        public Vector2 anchorMin { get; set; }
        public Vector2 anchorMax { get; set; }
        public Vector2 offsetMin { get; set; }
        public Vector2 offsetMax { get; set; }
        public Vector2 pivot { get; set; }
        public Vector2 sizeDelta { get; set; }
        public Vector2 anchoredPosition { get; set; }
        public Rect rect { get { return new Rect(); } }
    }

    public struct Rect
    {
        public float x, y, width, height;
        public Rect(float x, float y, float width, float height)
        {
            this.x = x; this.y = y; this.width = width; this.height = height;
        }
    }

    public struct Ray { public Vector3 origin, direction; }

    public struct RaycastHit { public Vector3 point; public float distance; }

    public class Collider : Component
    {
        public bool isTrigger { get; set; }
        public bool Raycast(Ray ray, out RaycastHit hit, float distance) { hit = new RaycastHit(); return false; }
    }

    public class BoxCollider : Collider { public Vector3 size { get; set; } }

    /// <summary>
    /// Present only so the play-mode test that asserts there are *no*
    /// rigidbodies in the scene can name the type it is looking for.
    /// Nothing in BREAKPOINT creates one.
    /// </summary>
    public class Rigidbody : Component
    {
        public bool isKinematic { get; set; }
        public Vector3 velocity { get; set; }
    }

    public class Texture : Object { public int anisoLevel { get; set; } }

    public enum TextureFormat { RGBA32 }
    public enum TextureWrapMode { Repeat, Clamp }
    public enum FilterMode { Point, Bilinear, Trilinear }

    public class Texture2D : Texture
    {
        public TextureWrapMode wrapModeU { get; set; }
        public TextureWrapMode wrapModeV { get; set; }
        public FilterMode filterMode { get; set; }
        public Texture2D(int width, int height, TextureFormat format, bool mipChain, bool linear) { }
        public void SetPixels32(Color32[] colors) { }
        public void Apply(bool updateMipmaps, bool makeNoLongerReadable) { }
    }

    public class Shader : Object { public static Shader Find(string name) { return null; } }

    public enum MaterialGlobalIlluminationFlags { EmissiveIsBlack }

    public class Material : Object
    {
        public int renderQueue { get; set; }
        public MaterialGlobalIlluminationFlags globalIlluminationFlags { get; set; }
        public Material(Shader shader) { }
        public bool HasProperty(string name) { return true; }
        public void SetColor(string name, Color value) { }
        public void SetFloat(string name, float value) { }
        public void SetInt(string name, int value) { }
        public void SetTexture(string name, Texture value) { }
        public void EnableKeyword(string keyword) { }
    }

    public class Mesh : Object
    {
        public Vector3[] vertices { get; set; }
        public Vector3[] normals { get; set; }
        public Vector2[] uv { get; set; }
        public int[] triangles { get; set; }
        public Rendering.IndexFormat indexFormat { get; set; }
        public void RecalculateTangents() { }
        public void RecalculateBounds() { }
    }

    public class MeshFilter : Component { public Mesh sharedMesh { get; set; } }

    public class Renderer : Component
    {
        public bool enabled { get; set; }
        public Material sharedMaterial { get; set; }
        public bool receiveShadows { get; set; }
        public Rendering.ShadowCastingMode shadowCastingMode { get; set; }
    }

    public class MeshRenderer : Renderer { }

    public class LineRenderer : Renderer
    {
        public bool useWorldSpace { get; set; }
        public int positionCount { get; set; }
        public float startWidth { get; set; }
        public float endWidth { get; set; }
        public int numCapVertices { get; set; }
        public LineAlignment alignment { get; set; }
        public void SetPosition(int index, Vector3 position) { }
    }

    public enum LineAlignment { View, TransformZ }

    public enum CameraClearFlags { Skybox, SolidColor, Depth, Nothing }

    public class Camera : Behaviour
    {
        public CameraClearFlags clearFlags { get; set; }
        public Color backgroundColor { get; set; }
        public float fieldOfView { get; set; }
        public float nearClipPlane { get; set; }
        public float farClipPlane { get; set; }
        public float aspect { get; set; }
        public Ray ScreenPointToRay(Vector3 position) { return new Ray(); }
        public Vector3 WorldToViewportPoint(Vector3 position) { return Vector3.zero; }
    }

    public enum LightType { Spot, Directional, Point, Area }
    public enum LightShadows { None, Hard, Soft }

    public class Light : Behaviour
    {
        public LightType type { get; set; }
        public Color color { get; set; }
        public float intensity { get; set; }
        public float range { get; set; }
        public float spotAngle { get; set; }
        public float innerSpotAngle { get; set; }
        public LightShadows shadows { get; set; }
        public float shadowBias { get; set; }
        public float shadowNormalBias { get; set; }
        public float shadowNearPlane { get; set; }
    }

    public class AudioListener : Behaviour { }

    public class Sprite : Object
    {
        public static Sprite Create(Texture2D texture, Rect rect, Vector2 pivot, float pixelsPerUnit)
        {
            return null;
        }
    }

    public class Font : Object { }

    public static class Resources
    {
        public static T GetBuiltinResource<T>(string path) where T : Object { return null; }
    }

    public static class Application
    {
        public static bool isPlaying { get { return true; } }
        public static string unityVersion { get { return "0"; } }
    }

    public static class Time { public static float deltaTime { get { return 0f; } } }

    public enum TouchPhase { Began, Moved, Stationary, Ended, Canceled }

    public struct Touch { public Vector2 position { get { return Vector2.zero; } } public TouchPhase phase { get { return TouchPhase.Began; } } }

    public static class Input
    {
        public static int touchCount { get { return 0; } }
        public static Touch GetTouch(int index) { return new Touch(); }
        public static Vector3 mousePosition { get { return Vector3.zero; } }
        public static Vector2 mouseScrollDelta { get { return Vector2.zero; } }
        public static bool GetMouseButton(int button) { return false; }
    }

    public static class Debug
    {
        public static void Log(object message) { }
        public static void LogWarning(object message) { }
        public static void LogError(object message) { }
    }

    public static class RenderSettings
    {
        public static Rendering.AmbientMode ambientMode { get; set; }
        public static Color ambientSkyColor { get; set; }
        public static Color ambientEquatorColor { get; set; }
        public static Color ambientGroundColor { get; set; }
    }

    public static class ColorUtility
    {
        public static bool TryParseHtmlString(string html, out Color color) { color = Color.black; return true; }
    }

    public enum TextAnchor
    {
        UpperLeft, UpperCenter, UpperRight,
        MiddleLeft, MiddleCenter, MiddleRight,
        LowerLeft, LowerCenter, LowerRight,
    }

    public enum HorizontalWrapMode { Wrap, Overflow }
    public enum VerticalWrapMode { Truncate, Overflow }

    [AttributeUsage(AttributeTargets.Class)]
    public sealed class DisallowMultipleComponent : Attribute { }

    [AttributeUsage(AttributeTargets.Field)]
    public sealed class TooltipAttribute : Attribute { public TooltipAttribute(string tooltip) { } }

    [AttributeUsage(AttributeTargets.Field)]
    public sealed class HeaderAttribute : Attribute { public HeaderAttribute(string header) { } }

    [AttributeUsage(AttributeTargets.Field)]
    public sealed class SerializeField : Attribute { }

    [AttributeUsage(AttributeTargets.Field)]
    public sealed class SpaceAttribute : Attribute { public SpaceAttribute() { } public SpaceAttribute(float height) { } }

    [AttributeUsage(AttributeTargets.Field)]
    public sealed class RangeAttribute : Attribute { public RangeAttribute(float min, float max) { } }

    [AttributeUsage(AttributeTargets.Class)]
    public sealed class CreateAssetMenuAttribute : Attribute
    {
        public string menuName;
        public string fileName;
        public int order;
    }

    public class CanvasGroup : Component
    {
        public float alpha { get; set; }
        public bool interactable { get; set; }
        public bool blocksRaycasts { get; set; }
    }

    public enum RenderMode { ScreenSpaceOverlay, ScreenSpaceCamera, WorldSpace }

    public class Canvas : Behaviour
    {
        public RenderMode renderMode { get; set; }
        public Camera worldCamera { get; set; }
    }
}

namespace UnityEngine.Rendering
{
    public enum ShadowCastingMode { Off, On, TwoSided, ShadowsOnly }
    public enum IndexFormat { UInt16, UInt32 }
    public enum AmbientMode { Skybox = 0, Trilight = 1, Flat = 3, Custom = 4 }
    public enum BlendMode { Zero, One, SrcAlpha, OneMinusSrcAlpha }
    public enum RenderQueue { Geometry = 2000, Transparent = 3000 }
}

namespace UnityEngine.UI
{
    public class Graphic : UnityEngine.Behaviour
    {
        public Color color { get; set; }
        public bool raycastTarget { get; set; }
    }

    public class Image : Graphic
    {
        public enum Type { Simple, Sliced, Tiled, Filled }
        public Sprite sprite { get; set; }
        public Type type { get; set; }
        public float pixelsPerUnitMultiplier { get; set; }
    }

    public class Text : Graphic
    {
        public string text { get; set; }
        public int fontSize { get; set; }
        public Font font { get; set; }
        public TextAnchor alignment { get; set; }
        public HorizontalWrapMode horizontalOverflow { get; set; }
        public VerticalWrapMode verticalOverflow { get; set; }
    }

    public struct ColorBlock
    {
        public Color normalColor, highlightedColor, pressedColor, selectedColor, disabledColor;
        public float colorMultiplier, fadeDuration;
    }

    public class Selectable : UnityEngine.Behaviour
    {
        public ColorBlock colors { get; set; }
        public Graphic targetGraphic { get; set; }
        public bool interactable { get; set; }
    }

    public class Button : Selectable { }

    public class CanvasScaler : UnityEngine.Behaviour
    {
        public enum ScaleMode { ConstantPixelSize, ScaleWithScreenSize, ConstantPhysicalSize }
        public enum ScreenMatchMode { MatchWidthOrHeight, Expand, Shrink }
        public ScaleMode uiScaleMode { get; set; }
        public Vector2 referenceResolution { get; set; }
        public ScreenMatchMode screenMatchMode { get; set; }
        public float matchWidthOrHeight { get; set; }
    }

    public class GraphicRaycaster : UnityEngine.Behaviour { }
}

namespace UnityEngine.EventSystems
{
    public class EventSystem : UnityEngine.Behaviour
    {
        public static EventSystem current { get { return null; } }
        public bool IsPointerOverGameObject() { return false; }
    }
}

namespace UnityEngine
{
    public static class RectTransformUtility
    {
        public static bool RectangleContainsScreenPoint(RectTransform rect, Vector2 screenPoint, Camera cam)
        {
            return false;
        }

        public static bool ScreenPointToLocalPointInRectangle(
            RectTransform rect, Vector2 screenPoint, Camera cam, out Vector2 localPoint)
        {
            localPoint = Vector2.zero;
            return false;
        }
    }
}
