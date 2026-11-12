// Voxels lit by Godot: lights, shadows and AO at the voxel each ray hits, not at the box. See
// voxel_volume.gdshaderinc.
shader_type spatial;
// Burley diffuse, as StandardMaterial3D uses, so a volume looks like an imported .glb mesh.
render_mode cull_front, diffuse_burley;

#include "voxel_volume.gdshaderinc"

void vertex() {
	vec3 local, camera, view_dir;
	voxel_vertex(VERTEX, MODEL_MATRIX, INV_VIEW_MATRIX, local, camera, view_dir);
	v_local = local;
	v_camera = camera;
	v_view_dir = view_dir;
}

void fragment() {
	bool orthographic = PROJECTION_MATRIX[3][3] == 1.0;
	VoxelHit hit;
	if (!voxel_march(v_local, v_camera, v_view_dir, orthographic, IN_SHADOW_PASS && shadow_through_solid, hit)) discard;
	float depth;
	vec3 view_position;
	if (!voxel_depth(hit, MODEL_MATRIX, VIEW_MATRIX, PROJECTION_MATRIX, depth, view_position)) discard;
	DEPTH = depth;
	// Light and shadows at the hit, with its face's normal.
	LIGHT_VERTEX = view_position;
	NORMAL = normalize(mat3(VIEW_MATRIX) * (MODEL_NORMAL_MATRIX * hit.normal));

	vec3 base = voxel_color(hit.value);
	vec4 glow = voxel_glow(hit);
	ALBEDO = base * (1.0 - glow.a);
	EMISSION = base * voxel_emission(hit.value) * emissive_intensity + glow.rgb * glow.a;
	ROUGHNESS = 1.0;
	// Like three.js's AO map: indirect light only.
	if (ambient_occlusion) AO = voxel_ao(hit);
}
