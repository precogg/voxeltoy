// Ray-marched voxels for Godot 4.5+ Forward+: the port of packages/three/src/voxel-volume.ts. A box
// mesh whose fragment shader walks the grid along each pixel's ray (Amanatides & Woo) and writes
// the depth of the voxel it hits. See docs/voxel-runtime.md.
//
// The node's local space is grid space: cell [x, y, z] spans x to x + 1 on each axis. The box mesh
// is centered on the origin; the vertex shader moves it to [offset, offset + size], the volume on
// show. Set the node's custom AABB to match. Make the box 2 × 0.0137 larger than the volume, as
// three.js's BOX_MARGIN: a camera exactly in the plane of a face puts that face's vertices at
// w = 0, where some rasterizers interpolate varyings badly. The march clips rays to the volume.

// R8: value = palette index / 255. Moxel's byte order: width x, height y, depth z.
uniform sampler3D volume : filter_nearest;
// 256×1: rgb = color, a = how much the entry glows.
uniform sampler2D palette : source_color, filter_nearest;
uniform vec3 size = vec3(1.0);
uniform vec3 offset = vec3(0.0);
uniform bool shade = true;
uniform bool ambient_occlusion = true;
// In shadow passes, march through the first run of solid voxels and use where the ray leaves it,
// so lit faces can't shadow themselves. Off: the first face, like a front-face shadow caster.
uniform bool shadow_through_solid = false;
// Effects, as in VoxelVolume.
uniform float dissolve : hint_range(0.0, 1.0) = 0.0;
uniform float dissolve_edge = 0.04;
uniform vec3 dissolve_color : source_color = vec3(1.0, 0.69, 0.29);
uniform bool clip_enabled = false;
uniform vec4 clip_plane = vec4(0.0);
uniform vec3 flash_center = vec3(0.0);
uniform float flash_radius = 3.0;
uniform vec3 flash_color : source_color = vec3(1.0);
uniform float flash_amount = 0.0;
uniform float emissive_intensity = 1.0;

varying vec3 v_local;
varying vec3 v_camera;
varying vec3 v_view_dir;

struct VoxelHit {
	int value;
	ivec3 cell;
	int axis;
	vec3 normal;   // outward, cell space
	vec3 position; // cell space of the volume on show
};

// Godot only lets vertex() itself write varyings, so this hands them back.
void voxel_vertex(inout vec3 vertex, mat4 model_matrix, mat4 inv_view_matrix, out vec3 local, out vec3 camera, out vec3 view_dir) {
	vertex += size * 0.5 + offset;
	mat4 to_local = inverse(model_matrix);
	local = vertex - offset;
	camera = (to_local * vec4(inv_view_matrix[3].xyz, 1.0)).xyz - offset;
	// The camera looks down its -Z axis.
	view_dir = (to_local * vec4(-inv_view_matrix[2].xyz, 0.0)).xyz;
}

int voxel_at(ivec3 c) {
	return int(texelFetch(volume, c, 0).r * 255.0 + 0.5);
}

// A stable random number in [0, 1) for a cell of the document grid, in steps of 1/65536. The same
// as voxelHash in packages/three/src/voxel-volume.ts.
float voxel_hash(ivec3 c) {
	uvec3 v = uvec3(c + ivec3(offset)) * uvec3(1597334673u, 3812015801u, 2798796415u);
	uint h = (v.x ^ v.y ^ v.z) * 1597334677u;
	return float(h >> 16u) / 65536.0;
}

bool voxel_hidden(ivec3 c) {
	if (dissolve > 0.0 && voxel_hash(c) < dissolve) return true;
	return clip_enabled && dot(clip_plane.xyz, vec3(c) + 0.5 + offset) + clip_plane.w > 0.0;
}

int voxel_shown(ivec3 c) {
	int v = voxel_at(c);
	return v != 0 && voxel_hidden(c) ? 0 : v;
}

float voxel_solid(ivec3 c, ivec3 n) {
	if (any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, n))) return 0.0;
	return voxel_shown(c) != 0 ? 1.0 : 0.0;
}

bool voxel_march(vec3 local, vec3 camera, vec3 view_dir, bool orthographic, bool through_solid, out VoxelHit hit) {
	ivec3 n = ivec3(size + 0.5);

	// The ray in cell space. An orthographic ray starts on the camera plane.
	vec3 rd;
	vec3 ro;
	if (orthographic) {
		rd = normalize(view_dir);
		ro = local - rd * dot(local - camera, rd);
	} else {
		ro = camera;
		rd = normalize(local - camera);
	}
	rd = vec3(
		abs(rd.x) < 1e-6 ? 1e-6 : rd.x,
		abs(rd.y) < 1e-6 ? 1e-6 : rd.y,
		abs(rd.z) < 1e-6 ? 1e-6 : rd.z
	);
	vec3 inv = 1.0 / rd;

	// Clip the ray to the box.
	vec3 t0 = -ro * inv;
	vec3 t1 = (size - ro) * inv;
	vec3 t_near = min(t0, t1);
	vec3 t_far = max(t0, t1);
	float t_enter = max(max(t_near.x, t_near.y), t_near.z);
	float t_exit = min(min(t_far.x, t_far.y), t_far.z);
	float t = max(t_enter, 0.0);
	if (t_exit <= t) return false;
	int axis = t_enter < 0.0 ? -1 : (t_enter == t_near.x ? 0 : (t_enter == t_near.y ? 1 : 2));

	ivec3 cell = clamp(ivec3(floor(ro + rd * (t + 1e-4))), ivec3(0), n - 1);
	ivec3 stp = ivec3(sign(rd));
	vec3 t_delta = abs(inv);
	vec3 t_max = (vec3(cell) + max(vec3(stp), vec3(0.0)) - ro) * inv;

	// A ray crosses at most sx + sy + sz cells.
	int value = 0;
	ivec3 hit_cell = cell;
	int hit_axis = axis;
	float hit_t = t;
	int steps = n.x + n.y + n.z + 3;
	for (int i = 0; i < steps; i++) {
		int v = voxel_shown(cell);
		if (value == 0) {
			if (v != 0) {
				value = v;
				hit_cell = cell;
				hit_axis = axis;
				hit_t = t;
				if (!through_solid) break;
			}
		} else if (v == 0) {
			break;
		}
		if (t_max.x < t_max.y && t_max.x < t_max.z) {
			cell.x += stp.x; t = t_max.x; t_max.x += t_delta.x; axis = 0;
			if (cell.x < 0 || cell.x >= n.x) break;
		} else if (t_max.y < t_max.z) {
			cell.y += stp.y; t = t_max.y; t_max.y += t_delta.y; axis = 1;
			if (cell.y < 0 || cell.y >= n.y) break;
		} else {
			cell.z += stp.z; t = t_max.z; t_max.z += t_delta.z; axis = 2;
			if (cell.z < 0 || cell.z >= n.z) break;
		}
	}
	if (value == 0) return false;

	// Started inside a solid cell: face the camera along the dominant axis.
	if (hit_axis < 0) {
		vec3 a = abs(rd);
		hit_axis = a.x >= a.y && a.x >= a.z ? 0 : (a.y >= a.z ? 1 : 2);
	}
	hit.value = value;
	hit.cell = hit_cell;
	hit.axis = hit_axis;
	hit.normal = vec3(0.0);
	hit.normal[hit_axis] = -float(stp[hit_axis]);
	hit.position = ro + rd * (through_solid ? t : hit_t);
	return true;
}

vec3 voxel_color(int value) {
	return texelFetch(palette, ivec2(value, 0), 0).rgb;
}

float voxel_emission(int value) {
	return texelFetch(palette, ivec2(value, 0), 0).a;
}

// Face order: -x, +x, -y, +y, -z, +z (the mesher's FACE_SHADE).
float voxel_face_shade(VoxelHit hit) {
	const float FACE_SHADE[6] = { 0.78, 0.86, 0.6, 1.0, 0.7, 0.92 };
	return FACE_SHADE[hit.axis * 2 + (hit.normal[hit.axis] > 0.0 ? 1 : 0)];
}

// The mesher's vertexAO and AO_SHADE.
float voxel_corner_ao(float side1, float side2, float corner) {
	float n = side1 > 0.5 && side2 > 0.5 ? 3.0 : side1 + side2 + corner;
	return n < 0.5 ? 1.0 : (n < 1.5 ? 0.87 : (n < 2.5 ? 0.77 : 0.66));
}

// The mesher's corners in (u, v): (0,0), (1,0), (1,1), (0,1), blended across the face.
float voxel_ao(VoxelHit hit) {
	ivec3 n = ivec3(size + 0.5);
	ivec3 c = hit.cell + ivec3(hit.normal);
	ivec3 u = hit.axis == 0 ? ivec3(0, 1, 0) : (hit.axis == 1 ? ivec3(0, 0, 1) : ivec3(1, 0, 0));
	ivec3 v = hit.axis == 0 ? ivec3(0, 0, 1) : (hit.axis == 1 ? ivec3(1, 0, 0) : ivec3(0, 1, 0));
	float u_minus = voxel_solid(c - u, n);
	float u_plus = voxel_solid(c + u, n);
	float v_minus = voxel_solid(c - v, n);
	float v_plus = voxel_solid(c + v, n);
	float a0 = voxel_corner_ao(u_minus, v_minus, voxel_solid(c - u - v, n));
	float a1 = voxel_corner_ao(u_plus, v_minus, voxel_solid(c + u - v, n));
	float a2 = voxel_corner_ao(u_plus, v_plus, voxel_solid(c + u + v, n));
	float a3 = voxel_corner_ao(u_minus, v_plus, voxel_solid(c - u + v, n));
	vec3 in_cell = clamp(hit.position - vec3(hit.cell), vec3(0.0), vec3(1.0));
	float fu = dot(in_cell, vec3(u));
	float fv = dot(in_cell, vec3(v));
	return mix(mix(a0, a1, fu), mix(a3, a2, fu), fv);
}

// Light a hit gives off besides its color: the dissolve edge, then a hit flash. .a is how much it
// replaces the voxel's own color.
vec4 voxel_glow(VoxelHit hit) {
	vec4 glow = vec4(0.0);
	if (dissolve > 0.0 && voxel_hash(hit.cell) < dissolve + dissolve_edge) glow = vec4(dissolve_color, 1.0);
	if (flash_amount > 0.0) {
		float d = distance(vec3(hit.cell) + 0.5 + offset, flash_center);
		float k = flash_amount * clamp(1.0 - d / max(flash_radius, 1e-3), 0.0, 1.0);
		glow = vec4(mix(glow.rgb, flash_color, k), max(glow.a, k));
	}
	return glow;
}

// Depth and the view-space hit for a hit, or false outside the clip range (a mesh would be clipped
// there too). Forward+ uses reverse Z with depth in [0, 1].
bool voxel_depth(VoxelHit hit, mat4 model_matrix, mat4 view_matrix, mat4 projection_matrix, out float depth, out vec3 view_position) {
	vec4 view = view_matrix * model_matrix * vec4(hit.position + offset, 1.0);
	vec4 clip = projection_matrix * view;
	depth = clip.z / clip.w;
	view_position = view.xyz;
	return depth >= 0.0 && depth <= 1.0;
}
