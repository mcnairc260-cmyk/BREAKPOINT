import * as THREE from 'three';
import { TABLE } from '../config/brand';
import { BALL_RADIUS, CUSHION_HEIGHT } from '../physics/PhysicsConstants';
import type { RailSegment, TableGeometry } from '../physics/TableGeometry';
import { clothTexture } from './BallTextures';

/**
 * The table, built directly from the same `TableGeometry` the simulation
 * collides against.
 *
 * Every cushion mesh is extruded along the exact segment the physics uses and
 * every jaw is drawn at the exact circle the physics uses, so there is no
 * second "visual" table that can drift out of agreement with the playable one.
 * If a ball looks like it went through a rail, the rail really was there.
 */

/** How far the wooden rail cap extends beyond the cushion. */
const RAIL_CAP_WIDTH = 0.09;
/** Depth of the cushion body, measured back from the nose. */
const CUSHION_DEPTH = 0.05;
const CUSHION_TOP = 0.0455;
const RAIL_CAP_TOP = 0.058;
const BED_DROP = 0.03;

export interface TableMeshes {
  root: THREE.Group;
  /** The playing surface, used as the ray target for pointer aiming. */
  clothSurface: THREE.Mesh;
}

export function buildTable(table: TableGeometry): TableMeshes {
  const root = new THREE.Group();
  const hx = table.length / 2;
  const hy = table.width / 2;

  // ---------------------------------------------------------------- the bed
  //
  // The bed is extruded from a shape with six holes punched in it, one per
  // pocket. That matters more than it sounds: with a solid slab the pocket
  // throat is buried underneath it and a "pocket" is just a dark disc painted
  // on cloth, which is exactly the tell that gives away a cheap table. With a
  // real hole you see down the throat, the ball disappears into it, and the
  // rail cut-outs read as cut-outs.
  const cloth = new THREE.MeshStandardMaterial({
    map: clothTexture(TABLE.cloth, 5.5),
    roughness: 0.96,
    metalness: 0,
    envMapIntensity: 0.35,
  });

  const frameDepth = 2 * CUSHION_DEPTH + RAIL_CAP_WIDTH;
  const outerX = hx + frameDepth;
  const outerY = hy + frameDepth;

  // The shape is built in physics coordinates. Rotating it by -90° about X
  // sends the shape's y axis to world -Z (which is the physics +y direction)
  // and sends the extrusion up +Y, so the cap generated at the far end of the
  // extrusion is the one facing the camera. Rotating the other way puts the
  // cloth's only front-facing surface underneath the table, where it is
  // backface-culled and the table renders as nothing at all.
  const bedShape = new THREE.Shape();
  bedShape.moveTo(-outerX, -outerY);
  bedShape.lineTo(outerX, -outerY);
  bedShape.lineTo(outerX, outerY);
  bedShape.lineTo(-outerX, outerY);
  bedShape.closePath();
  for (const pocket of table.pockets) {
    const hole = new THREE.Path();
    hole.absarc(pocket.centre.x, pocket.centre.y, pocket.mouthRadius, 0, Math.PI * 2, true);
    bedShape.holes.push(hole);
  }

  const bedGeometry = new THREE.ExtrudeGeometry(bedShape, {
    depth: BED_DROP,
    bevelEnabled: false,
    curveSegments: 24,
  });
  bedGeometry.rotateX(-Math.PI / 2);
  // The extrusion runs upwards from the shape, so drop the whole slab to put
  // the playing surface at exactly y = 0.
  bedGeometry.translate(0, -BED_DROP, 0);

  const bed = new THREE.Mesh(bedGeometry, cloth);
  bed.receiveShadow = true;
  bed.castShadow = true;
  root.add(bed);

  // An invisible plane covering exactly the cushion-to-cushion rectangle, used
  // as the ray target for tap-to-aim. It is a separate object from the bed so
  // that a tap can never land in a pocket throat or out on the rail.
  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(table.length, table.width),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = 0.0004;
  root.add(surface);

  // ------------------------------------------------------------- the pockets
  const voidMat = new THREE.MeshStandardMaterial({
    color: TABLE.pocketVoid,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  // Matte and dark: a glossy liner catches the lamp at grazing angles and
  // flares into a bright arch over the mouth, which reads as a hoop above the
  // pocket rather than as the rim of a hole.
  const linerMat = new THREE.MeshStandardMaterial({
    color: TABLE.jaw,
    roughness: 0.95,
    metalness: 0,
    envMapIntensity: 0.2,
  });
  for (const pocket of table.pockets) {
    const throat = new THREE.Mesh(
      new THREE.CylinderGeometry(pocket.mouthRadius, pocket.mouthRadius * 0.8, 0.17, 28, 1, true),
      voidMat,
    );
    throat.position.set(pocket.centre.x, -0.085, -pocket.centre.y);
    root.add(throat);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(pocket.mouthRadius * 0.8, 28), voidMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(pocket.centre.x, -0.169, -pocket.centre.y);
    root.add(floor);

    // A flat liner ring lying on the cloth around the mouth. Flat, because a
    // torus standing proud of the surface reads as a hoop, not a pocket.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(pocket.mouthRadius, pocket.mouthRadius + 0.009, 32),
      linerMat,
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pocket.centre.x, 0.0006, -pocket.centre.y);
    root.add(ring);
  }

  // ------------------------------------------------------------ the cushions
  const cushionMat = new THREE.MeshStandardMaterial({
    color: TABLE.cushion,
    roughness: 0.85,
    metalness: 0.02,
  });
  for (const rail of table.rails) root.add(buildCushion(rail, cushionMat));

  // The jaws, drawn at exactly the circles the simulation bounces balls off.
  // Jaws are the rounded ends of the cushions themselves, so they share the
  // cushion's colour; in liner black they read as free-standing posts.
  const jawMat = new THREE.MeshStandardMaterial({
    color: TABLE.cushion,
    roughness: 0.85,
    metalness: 0.02,
  });
  for (const jaw of table.jaws) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(jaw.radius, jaw.radius, CUSHION_TOP, 16),
      jawMat,
    );
    mesh.position.set(jaw.centre.x, CUSHION_TOP / 2, -jaw.centre.y);
    mesh.castShadow = true;
    root.add(mesh);
  }

  // ------------------------------------------------------------ the rail cap
  const woodMat = new THREE.MeshStandardMaterial({
    color: TABLE.railWood,
    roughness: 0.68,
    metalness: 0.05,
    envMapIntensity: 0.5,
  });
  const capHeight = RAIL_CAP_TOP;
  const capDepth = CUSHION_DEPTH + RAIL_CAP_WIDTH;

  // One cap per cushion, spanning the same stretch of rail and overhanging each
  // end far enough to close up against the pocket mouth. Building the frame as
  // four continuous boxes instead would roof over every pocket, which is what
  // makes a table look like a box with holes painted on it.
  for (const rail of table.rails) {
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(rail.length + CUSHION_DEPTH * 3.2, capHeight, capDepth),
      woodMat,
    );
    const midX = (rail.a.x + rail.b.x) / 2;
    const midY = (rail.a.y + rail.b.y) / 2;
    // Sit the cap just outside the cushion face.
    const outX = -rail.normal.x * (CUSHION_DEPTH + capDepth / 2);
    const outY = -rail.normal.y * (CUSHION_DEPTH + capDepth / 2);
    cap.position.set(midX + outX, capHeight / 2 - 0.001, -(midY + outY));
    cap.rotation.y = -Math.atan2(-rail.tangent.y, rail.tangent.x);
    cap.castShadow = true;
    cap.receiveShadow = true;
    root.add(cap);
  }

  // Centre line of the rail cap, where the sight diamonds are inlaid. The
  // outer edge of the frame is `outerX` / `outerY`, shared with the bed so the
  // body can never end up a different size from the cloth it sits under.
  const capMidX = hx + CUSHION_DEPTH + capDepth / 2;
  const capMidY = hy + CUSHION_DEPTH + capDepth / 2;

  // Sight diamonds — the small inlays players line bank shots up with. They
  // cost almost nothing and their absence is one of the loudest "this is a
  // programmer's table" signals.
  const diamondMat = new THREE.MeshStandardMaterial({
    color: TABLE.chrome,
    roughness: 0.25,
    metalness: 0.9,
  });
  const diamondGeo = new THREE.OctahedronGeometry(0.0075);
  for (const i of [-3, -2, -1, 1, 2, 3]) {
    for (const sz of [-1, 1]) {
      const d = new THREE.Mesh(diamondGeo, diamondMat);
      d.position.set((i * table.length) / 8, capHeight - 0.002, sz * capMidY);
      d.scale.y = 0.45;
      root.add(d);
    }
  }
  for (const i of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const d = new THREE.Mesh(diamondGeo, diamondMat);
      d.position.set(sx * capMidX, capHeight - 0.002, (i * table.width) / 4);
      d.scale.y = 0.45;
      root.add(d);
    }
  }

  // ---------------------------------------------------------------- the body
  const bodyMat = new THREE.MeshStandardMaterial({
    color: TABLE.railWood,
    roughness: 0.55,
    metalness: 0.05,
  });
  const skirt = new THREE.Mesh(
    new THREE.BoxGeometry(outerX * 2 - 0.01, 0.22, outerY * 2 - 0.01),
    bodyMat,
  );
  skirt.position.y = -0.03 - 0.11;
  skirt.castShadow = true;
  skirt.receiveShadow = true;
  root.add(skirt);

  const legGeo = new THREE.BoxGeometry(0.14, 0.55, 0.14);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, bodyMat);
      leg.position.set(sx * (outerX - 0.12), -0.14 - 0.275, sz * (outerY - 0.12));
      leg.castShadow = true;
      root.add(leg);
    }
  }

  return { root, clothSurface: surface };
}

/**
 * One cushion, extruded along its segment.
 *
 * The cross-section is the real profile rather than a rectangle: the nose sits
 * proud at CUSHION_HEIGHT with the face falling away beneath it, which is both
 * what a K-66 cushion looks like and the geometry the impulse solver assumes
 * when it places the contact point above the ball's centre.
 */
function buildCushion(rail: RailSegment, material: THREE.Material): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(0, CUSHION_HEIGHT); // the nose
  shape.lineTo(0.007, 0.0); // undercut down to the cloth
  shape.lineTo(CUSHION_DEPTH, 0.0);
  shape.lineTo(CUSHION_DEPTH, CUSHION_TOP);
  shape.lineTo(0.006, CUSHION_TOP);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: rail.length,
    bevelEnabled: false,
    curveSegments: 1,
  });

  // The shape lives in local XY and extrudes along local +Z, so the mesh needs
  // a basis whose X is "outward from the nose", Y is up, and Z runs along the
  // rail. Building it with makeBasis rather than an Euler angle keeps it right
  // for all four rail orientations at once; deriving Z from X × Y guarantees
  // the basis stays right-handed, so no cushion ends up inside out.
  const outward = new THREE.Vector3(-rail.normal.x, 0, rail.normal.y).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const along = new THREE.Vector3().crossVectors(outward, up);

  const tangent = new THREE.Vector3(rail.tangent.x, 0, -rail.tangent.y);
  // If that Z points down the rail the wrong way, extrude from the far end.
  const start = along.dot(tangent) >= 0 ? rail.a : rail.b;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.setRotationFromMatrix(new THREE.Matrix4().makeBasis(outward, up, along));
  mesh.position.set(start.x, 0, -start.y);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Height at which a ball's centre sits, in render units. */
export const BALL_CENTRE_HEIGHT = BALL_RADIUS;
