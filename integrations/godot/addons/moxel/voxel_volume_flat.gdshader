// Voxels unlit, shaded like Moxel's viewport: face shading and AO. See voxel_volume.gdshaderinc.
shader_type spatial;
render_mode unshaded, cull_front;

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

	float f = 1.0;
	if (shade) f = voxel_face_shade(hit);
	if (ambient_occlusion) f *= voxel_ao(hit);
	// Glowing palette entries ignore shading; unlit has nothing brighter to give them.
	f = mix(f, 1.0, voxel_emission(hit.value));
	vec4 glow = voxel_glow(hit);
	ALBEDO = mix(voxel_color(hit.value) * f, glow.rgb, glow.a);
}
