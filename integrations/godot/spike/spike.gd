## The voxel runtime spike (docs/voxel-runtime.md, stage 4). Run from integrations/godot:
##
##   godot --path . -s spike/spike.gd -- views   flat renders of fixtures/views.json, for compare.ts
##   godot --path . -s spike/spike.gd -- lit     volume beside a mesh of the same voxels, lit, per light
##   godot --path . -s spike/spike.gd -- perf    GPU time at 1080p, volumes against meshes
##   godot --path . -s spike/spike.gd -- demo    the shooting gallery, with scripted shots
##
## Images go to spike/out/. Needs a window: on a headless machine, use xvfb-run.
extends SceneTree

const VoxelMesh := preload("res://spike/voxel_mesh.gd")
const OUT := "res://spike/out"
const BACKGROUND := Color8(0x9a, 0xa3, 0xad)

var models := {}


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(OUT))
	print("Godot %s on %s, %s" % [Engine.get_version_info().string, RenderingServer.get_video_adapter_name(), RenderingServer.get_current_rendering_method()])
	for name in ["ball", "critter"]:
		models[name] = MoxelVolumeAnimation.load_file(ProjectSettings.globalize_path("res://fixtures/" + name))
	var args := OS.get_cmdline_user_args()
	var mode := args[0] if args.size() > 0 else "views"
	match mode:
		"views":
			await _views()
		"lit":
			await _lit(args.slice(1))
		"perf":
			await _perf(args.slice(1))
		"demo":
			await _demo()
	quit()


## A MoxelVolume3D showing frame `frame_index` of `vols`.
func volume_node(vols: MoxelVolumeAnimation, frame_index: int, lighting: MoxelVolume3D.Lighting) -> MoxelVolume3D:
	var node := MoxelVolume3D.new()
	node.lighting = lighting
	node.animation = vols
	node.frame = frame_index
	return node


func make_viewport(size: Vector2i) -> SubViewport:
	var vp := SubViewport.new()
	vp.size = size
	vp.own_world_3d = true
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(vp)
	return vp


func make_camera(view: Dictionary, parent: Node) -> Camera3D:
	var c: Dictionary = view.camera
	var camera := Camera3D.new()
	parent.add_child(camera)
	camera.fov = c.fov
	camera.near = c.near
	camera.far = c.far
	if c.has("orthoHeight"):
		camera.projection = Camera3D.PROJECTION_ORTHOGONAL
		camera.size = c.orthoHeight
	camera.look_at_from_position(_v3(c.position), _v3(c.target))
	camera.current = true
	return camera


func environment(parent: Node, ambient: float) -> void:
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = BACKGROUND
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color.WHITE
	env.ambient_light_energy = ambient
	env.tonemap_mode = Environment.TONE_MAPPER_LINEAR
	var world := WorldEnvironment.new()
	world.environment = env
	parent.add_child(world)


func capture(vp: SubViewport, file: String) -> void:
	for i in 4:
		await RenderingServer.frame_post_draw
	vp.get_texture().get_image().save_png(OUT.path_join(file))


## Flat renders of each fixture view, to compare with three.js's.
func _views() -> void:
	var views = JSON.parse_string(FileAccess.get_file_as_string("res://fixtures/views.json"))
	for view in views:
		var vp := make_viewport(Vector2i(view.width, view.height))
		environment(vp, 0.0)
		var node := volume_node(models[view.model], view.frame, MoxelVolume3D.Lighting.FLAT)
		node.shade = view.shade
		node.ambient_occlusion = view.ao
		vp.add_child(node)
		make_camera(view, vp)
		await capture(vp, "godot-%s.png" % view.name)
		print("  wrote godot-%s.png" % view.name)
		vp.queue_free()


## The ball, lit, as a volume and as a mesh, with a floor and a pole; one light at a time.
func _lit(args: Array) -> void:
	var shadows := not args.has("noshadow")
	var vols: MoxelVolumeAnimation = models.ball
	var view := { camera = { position = [70, 50, 80], target = [16, 13, 16], fov = 40, near = 0.5, far = 500 } }
	for light_kind in ["sun", "spot", "omni-cube", "omni-paraboloid"]:
		for through in [false, true]:
			for kind in ["mesh", "volume"]:
				if kind == "mesh" and through:
					continue
				var vp := make_viewport(Vector2i(640, 480))
				environment(vp, 0.35)
				if kind == "volume":
					var node := volume_node(vols, 0, MoxelVolume3D.Lighting.LIT)
					node.ambient_occlusion = false
					node.material_override.set_shader_parameter("shadow_through_solid", through)
					vp.add_child(node)
				else:
					var mesh := MeshInstance3D.new()
					mesh.mesh = VoxelMesh.build(vols, 0)
					var standard := StandardMaterial3D.new()
					standard.vertex_color_use_as_albedo = true
					standard.vertex_color_is_srgb = true
					standard.roughness = 1.0
					mesh.material_override = standard
					vp.add_child(mesh)
				_props(vp)
				var light := _light(light_kind)
				light.shadow_enabled = shadows
				vp.add_child(light)
				make_camera(view, vp)
				var file := "lit%s-%s-%s%s.png" % ["" if shadows else "-noshadow", light_kind, kind, "-through" if through else ""]
				await capture(vp, file)
				print("  wrote ", file)
				vp.queue_free()


func _props(parent: Node) -> void:
	var floor := MeshInstance3D.new()
	var floor_mesh := BoxMesh.new()
	floor_mesh.size = Vector3(52, 0.25, 52)
	floor.mesh = floor_mesh
	floor.position = Vector3(16, 9.6, 16)
	var pole := MeshInstance3D.new()
	var pole_mesh := BoxMesh.new()
	pole_mesh.size = Vector3(2.5, 45, 2.5)
	pole.mesh = pole_mesh
	pole.position = Vector3(20.8, 16, 19.2)
	for node in [floor, pole]:
		var m := StandardMaterial3D.new()
		m.albedo_color = Color8(0x9a, 0xa3, 0xad) if node == floor else Color8(0x3d, 0x44, 0x50)
		m.roughness = 1.0
		node.material_override = m
		parent.add_child(node)


func _light(kind: String) -> Light3D:
	var light: Light3D
	match kind:
		"sun":
			light = DirectionalLight3D.new()
			light.light_energy = 1.4
		"spot":
			var spot := SpotLight3D.new()
			spot.spot_range = 200
			spot.spot_angle = 32
			spot.spot_attenuation = 0.0
			spot.light_energy = 2.0
			light = spot
		_:
			var omni := OmniLight3D.new()
			omni.omni_range = 200
			omni.omni_attenuation = 0.0
			omni.omni_shadow_mode = OmniLight3D.SHADOW_CUBE if kind == "omni-cube" else OmniLight3D.SHADOW_DUAL_PARABOLOID
			omni.light_energy = 1.6
			light = omni
	light.shadow_enabled = true
	var at := Vector3(16, 12, 16)
	# From the far side, so shadows fall toward the camera: onto the floor and into the tunnel.
	var from := at + Vector3(-50, 70, -20) if kind == "sun" else at + Vector3(-30, 42, -12)
	light.transform = Transform3D(Basis.looking_at(at - from, Vector3.UP), from)
	return light


## GPU time per frame at 1920×1080 for critters as volumes and as meshes: 1, 10 and 50 of them,
## and one filling the screen. Lit by a sun with shadows.
func _perf(args: Array) -> void:
	var vols: MoxelVolumeAnimation = models.critter
	var lighting: String = args[0] if args.size() > 0 else "lit"
	var meshes := []
	for pose in vols.get_pose_count():
		meshes.append(VoxelMesh.build(vols, pose))
	var standard := StandardMaterial3D.new()
	standard.vertex_color_use_as_albedo = true
	standard.vertex_color_is_srgb = true
	standard.roughness = 1.0
	if lighting == "flat":
		standard.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	var cases := [["1 small", 1, 160.0], ["10", 10, 160.0], ["50", 50, 220.0], ["1 fills the screen", 1, 26.0]]
	var prepass: bool = ProjectSettings.get_setting("rendering/driver/depth_prepass/enable", true)
	print("lighting %s, depth prepass %s" % [lighting, "on" if prepass else "off"])
	print("case | kind | GPU ms (median of 240 frames)")
	for c in cases:
		for kind in ["mesh", "volume"]:
			var vp := make_viewport(Vector2i(1920, 1080))
			environment(vp, 0.4)
			var sun := DirectionalLight3D.new()
			sun.shadow_enabled = lighting == "lit"
			sun.transform = Transform3D(Basis.looking_at(Vector3(-0.4, -1, -0.3), Vector3.UP), Vector3.ZERO)
			vp.add_child(sun)
			var count: int = c[1]
			var columns := ceili(sqrt(count))
			for i in count:
				var place := Vector3((i % columns) * 26.0 - (columns - 1) * 13.0 - 10, 0, (i / columns) * 26.0 - (columns - 1) * 13.0 - 8)
				var node: GeometryInstance3D
				if kind == "volume":
					node = volume_node(vols, 0, MoxelVolume3D.Lighting.LIT if lighting == "lit" else MoxelVolume3D.Lighting.FLAT)
				else:
					node = MeshInstance3D.new()
					node.mesh = meshes[0]
					node.material_override = standard
				node.position = place
				vp.add_child(node)
			var camera := Camera3D.new()
			vp.add_child(camera)
			camera.fov = 50
			var distance: float = c[2]
			camera.look_at_from_position(Vector3(0, distance * 0.6, distance), Vector3(0, 8, 0))
			camera.current = true
			var rid := vp.get_viewport_rid()
			RenderingServer.viewport_set_measure_render_time(rid, true)
			# Let clocks and shadow maps settle, then take the median frame.
			for i in 90:
				await RenderingServer.frame_post_draw
			var times := PackedFloat64Array()
			for i in 240:
				await RenderingServer.frame_post_draw
				times.append(RenderingServer.viewport_get_measured_render_time_gpu(rid))
			times.sort()
			print("%s | %s | %.3f" % [c[0], kind, times[times.size() / 2]])
			if c[0] == "1 fills the screen":
				await capture(vp, "perf-%s-%s.png" % [lighting, kind])
			vp.queue_free()
			await RenderingServer.frame_post_draw


static func _v3(a: Array) -> Vector3:
	return Vector3(a[0], a[1], a[2])


## Plays demo/shooting_gallery.tscn with scripted shots at the first critter until it is knocked
## out, then waits for it to come back. Captures each step.
func _demo() -> void:
	var vp := make_viewport(Vector2i(1280, 720))
	var demo = load("res://demo/shooting_gallery.tscn").instantiate()
	vp.add_child(demo)
	for i in 30:
		await RenderingServer.frame_post_draw
	await capture(vp, "demo-start.png")
	var offsets := [Vector2.ZERO, Vector2(-14, 0), Vector2(14, 0), Vector2(0, -14), Vector2(0, 14), Vector2(-10, 10), Vector2(10, -10)]
	for i in 3:
		demo.shoot(demo.critter_screen_position(0))
		await RenderingServer.frame_post_draw
	for i in 4:
		await RenderingServer.frame_post_draw
	print("after 3 shots: hits %d, debris %d, state %s" % [demo.hits, demo.debris_count(), demo.critter_state(0)])
	await capture(vp, "demo-hits.png")
	var tries := 0
	while demo.critter_state(0) == "alive" and tries < 60:
		demo.shoot(demo.critter_screen_position(0) + offsets[tries % offsets.size()])
		tries += 1
		await RenderingServer.frame_post_draw
	print("knocked out after %d more shots: state %s" % [tries, demo.critter_state(0)])
	for i in 12:
		await RenderingServer.frame_post_draw
	await capture(vp, "demo-dissolve.png")
	var start := Time.get_ticks_msec()
	while demo.critter_state(0) != "alive" and Time.get_ticks_msec() - start < 5000:
		await RenderingServer.frame_post_draw
	print("back: state %s, knocked out %d, hits %d of %d" % [demo.critter_state(0), demo.knocked_out, demo.hits, demo.shots])

