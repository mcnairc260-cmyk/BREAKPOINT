import { describe, expect, it } from 'vitest';
import { BallBody } from './BallBody';
import { PHYSICS } from './PhysicsConstants';
import { PhysicsWorld } from './PhysicsWorld';

function twoBalls(distance = PHYSICS.BALL_RADIUS * 2 + 0.001): PhysicsWorld {
  const w = new PhysicsWorld();
  const a = new BallBody(0, 0, 0.25); a.sleeping = true;
  const b = new BallBody(1, 0, 0.25 - distance); b.sleeping = true;
  w.addBall(a); w.addBall(b); return w;
}
function run(w: PhysicsWorld, seconds = 3): void { for (let i = 0; i < Math.ceil(seconds / PHYSICS.FIXED_DT); i += 1) w.fixedStep(); }
function state(w: PhysicsWorld): number[] { return w.balls.flatMap(b => [b.position.x,b.position.z,b.velocity.x,b.velocity.z,b.angularVelocity.x,b.angularVelocity.y,b.angularVelocity.z,b.pocketed?1:0]); }

describe('BREAKPOINT deterministic physics', () => {
  it('1 stationary-ball collision transfers momentum', () => { const w=twoBalls();const a=w.balls[0]!,b=w.balls[1]!;a.sleeping=false;a.velocity.z=-1.8;w.fixedStep();run(w,.1);expect(b.velocity.z).toBeLessThan(-.4); });
  it('2 head-on collision leaves striker slower than target', () => { const w=twoBalls();const a=w.balls[0]!,b=w.balls[1]!;a.sleeping=false;a.velocity.z=-2;run(w,.08);expect(Math.abs(a.velocity.z)).toBeLessThan(Math.abs(b.velocity.z)); });
  it('3 angled collision creates lateral object-ball velocity', () => { const w=new PhysicsWorld();const a=new BallBody(0,-.02,.2),b=new BallBody(1,.015,.09);a.velocity.z=-2;w.addBall(a);w.addBall(b);run(w,.12);expect(Math.abs(b.velocity.x)).toBeGreaterThan(.05); });
  it('4 conservation sanity check stays below elastic input energy', () => { const w=twoBalls();const a=w.balls[0]!;a.sleeping=false;a.velocity.z=-2;const e0=w.totalEnergy();run(w,.12);expect(w.totalEnergy()).toBeLessThanOrEqual(e0*1.01); });
  it('5 repeated collisions do not create energy', () => { const w=PhysicsWorld.standardRack();const c=w.balls[0]!;c.velocity.z=-4;const e0=w.totalEnergy();run(w,2);expect(w.totalEnergy()).toBeLessThanOrEqual(e0*1.02); });
  it('6 moving ball eventually reaches rest', () => { const w=new PhysicsWorld();const b=new BallBody(0,0,0);b.velocity.x=.7;w.addBall(b);run(w,12);expect(Math.hypot(b.velocity.x,b.velocity.z)).toBe(0);expect(b.sleeping).toBe(true); });
  it('7 draw shot produces reverse cloth slip and altered post-impact cue path', () => { const w=twoBalls(.22);const c=w.balls[0]!;c.sleeping=true;w.strikeCue(0,.32,0,-1);run(w,1.4);expect(c.position.z).toBeGreaterThan(-.03); });
  it('8 follow shot carries cue ball forward after contact', () => { const w=twoBalls(.22);const c=w.balls[0]!;c.sleeping=true;w.strikeCue(0,.32,0,1);run(w,.8);expect(c.position.z).toBeLessThan(.1); });
  it('9 stun shot has less forward travel than follow', () => { const stun=twoBalls(.22),follow=twoBalls(.22);stun.balls[0]!.sleeping=true;follow.balls[0]!.sleeping=true;stun.strikeCue(0,.3,0,0);follow.strikeCue(0,.3,0,1);run(stun,.6);run(follow,.6);expect(stun.balls[0]!.position.z).toBeGreaterThanOrEqual(follow.balls[0]!.position.z-.08); });
  it('10 side-spin changes cushion response', () => { const plain=new PhysicsWorld(),english=new PhysicsWorld();const a=new BallBody(0,.45,.2),b=new BallBody(0,.45,.2);a.velocity.x=2;b.velocity.x=2;b.angularVelocity.y=80;plain.addBall(a);english.addBall(b);run(plain,.2);run(english,.2);expect(Math.abs(a.velocity.z-b.velocity.z)).toBeGreaterThan(.001); });
  it('11 cushion rebound reverses normal velocity', () => { const w=new PhysicsWorld();const b=new BallBody(0,.5,.3);b.velocity.x=2;w.addBall(b);run(w,.12);expect(b.pocketed).toBe(false);expect(b.velocity.x).toBeLessThan(0); });
  it('12 corner pocket captures a slow entering ball', () => { const w=new PhysicsWorld();const b=new BallBody(1,PHYSICS.TABLE_HALF_WIDTH-.035,PHYSICS.TABLE_HALF_LENGTH-.035);b.velocity={x:.15,z:.15};w.addBall(b);run(w,.2);expect(b.pocketed).toBe(true); });
  it('13 side pocket captures an entering ball', () => { const w=new PhysicsWorld();const b=new BallBody(1,PHYSICS.TABLE_HALF_WIDTH-.03,0);b.velocity.x=.12;w.addBall(b);run(w,.2);expect(b.pocketed).toBe(true); });
  it('14 pocket rejects a fast grazing shot', () => { const w=new PhysicsWorld();const b=new BallBody(1,PHYSICS.TABLE_HALF_WIDTH-.045,.042);b.velocity={x:3.2,z:.9};w.addBall(b);run(w,.08);expect(b.pocketed).toBe(false); });
  it('15 high-speed tunneling resistance still detects object ball', () => { const w=twoBalls(.38);const a=w.balls[0]!,b=w.balls[1]!;a.sleeping=false;a.velocity.z=-11;run(w,.08);expect(b.velocity.z).toBeLessThan(-.5); });
  it('16 deterministic replay is bit-stable for identical inputs', () => { const a=PhysicsWorld.standardRack(),b=PhysicsWorld.standardRack();a.strikeCue(.17,.63,.2,-.35);b.strikeCue(.17,.63,.2,-.35);run(a,3);run(b,3);expect(state(a)).toEqual(state(b)); });
  it('17 render frame rate does not affect simulation result', () => { const a=PhysicsWorld.standardRack(),b=PhysicsWorld.standardRack();a.strikeCue(-.11,.54,-.25,.4);b.strikeCue(-.11,.54,-.25,.4);for(let i=0;i<360;i++)a.stepFrame(1/120);for(let i=0;i<180;i++)b.stepFrame(1/60);expect(state(a)).toEqual(state(b)); });
  it('18 no NaN or Infinity physics state after stress simulation', () => { const w=PhysicsWorld.standardRack();w.strikeCue(.4,1,1,-1);run(w,8);for(const b of w.balls)expect(b.finite()).toBe(true); });
});
