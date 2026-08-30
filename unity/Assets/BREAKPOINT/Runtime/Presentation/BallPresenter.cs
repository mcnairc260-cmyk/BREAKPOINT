using Breakpoint.Simulation;
using UnityEngine;

namespace Breakpoint.Presentation
{
    /// <summary>
    /// One ball's visual. Reads simulation state; never writes it.
    ///
    /// The contract this class exists to enforce:
    ///
    ///   PhysicsWorld  →  BallBody  →  BallPresenter  →  Transform
    ///
    /// and nothing flows the other way. There is no Rigidbody, no Collider and
    /// no PhysX interaction on this object at all, so there is no mechanism by
    /// which a Transform nudge — an animation, a parent scale, a stray editor
    /// drag — could reach the authoritative state. The ball it presents is held
    /// as a reference so it can be read, and every write in this file targets a
    /// Unity component.
    ///
    /// Pocketing is presented, not decided. The simulation flags a ball
    /// <see cref="BallBody.Pocketed"/> and the presenter plays a short drop; if
    /// the drop were the thing that removed the ball, a dropped frame would
    /// change the game.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class BallPresenter : MonoBehaviour
    {
        /// <summary>How long the ball takes to sink out of sight after capture.</summary>
        private const float DropSeconds = 0.42f;

        /// <summary>How far below the cloth it falls.</summary>
        private const float DropDepth = 0.16f;

        private BallBody _ball;
        private Transform _model;
        private float _dropElapsed = -1f;

        public int Number { get; private set; }

        /// <summary>The ball this presenter reads. Read-only by convention and by use.</summary>
        public BallBody Ball => _ball;

        public void Bind(BallBody ball, Transform model)
        {
            _ball = ball;
            _model = model;
            Number = ball.Number;
            _dropElapsed = ball.Pocketed ? DropSeconds : -1f;
            Sync(0f);
        }

        /// <summary>
        /// Copy the current simulation state onto the Transform.
        ///
        /// Called once per rendered frame from the bootstrap, after the fixed
        /// steps for that frame have run. Deliberately not in this component's
        /// own Update: ordering between "advance the world" and "read the world"
        /// must not depend on Unity's script execution order.
        /// </summary>
        public void Sync(float deltaTime)
        {
            if (_ball == null) return;

            if (_ball.Pocketed)
            {
                if (_dropElapsed < 0f) _dropElapsed = 0f;
                else _dropElapsed = Mathf.Min(_dropElapsed + deltaTime, DropSeconds);

                float t = DropSeconds <= 0f ? 1f : _dropElapsed / DropSeconds;
                if (t >= 1f)
                {
                    if (gameObject.activeSelf) gameObject.SetActive(false);
                    return;
                }

                // Ease in: it accelerates as it falls, like a ball would.
                float fall = t * t;
                transform.position = TableFrame.Plane(
                    _ball.Position,
                    (float)PhysicsConstants.BallRadius - DropDepth * fall);
                if (_model != null) _model.localScale = Vector3.one * (1f - 0.25f * fall);
                return;
            }

            if (!gameObject.activeSelf) gameObject.SetActive(true);
            _dropElapsed = -1f;
            if (_model != null) _model.localScale = Vector3.one;

            transform.position = TableFrame.Plane(_ball.Position, (float)PhysicsConstants.BallRadius);
            transform.rotation = TableFrame.Rotation(_ball.Orientation);
        }

        /// <summary>Put the presenter back to a freshly-racked state.</summary>
        public void ResetVisual()
        {
            _dropElapsed = -1f;
            if (_model != null) _model.localScale = Vector3.one;
            gameObject.SetActive(true);
            Sync(0f);
        }
    }
}
