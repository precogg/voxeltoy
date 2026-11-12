## The voxel runtime demo, as in Moxel's three.js dev page (apps/web/dev/voxel-game.ts): animated
## critters walk around an arena; click or tap one to blast voxels out of it. A hit carves every
## pose, throws the voxels as debris and flashes; enough damage dissolves a critter, and it
## dissolves back in elsewhere. Eyes and antennas glow.
extends Node3D

const CRITTER := preload("res://demo/critter.moxelvol")
const COUNT := 8
const EYE := 4
const ANTENNA := 6
const BLAST := 3.2
const MAX_DEBRIS := 3000

var hits := 0
var shots := 0
var knocked_out := 0

var _critters: Array[Dictionary] = []
var _debris: Array[Dictionary] = []
var _multimesh: MultiMesh
var _camera: Camera3D
var _hud: Label
var _frame_ms := PackedFloat32Array()


func _ready() -> void:
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color(0.73, 0.83, 0.91)
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color.WHITE
	env.ambient_light_energy = 0.35
	var world := WorldEnvironment.new()
	world.environment = env
	add_child(world)

	var sun := DirectionalLight3D.new()
	sun.shadow_enabled = true
	sun.light_energy = 1.0
	# the camera is about 200 units out; shadows end 100 from it by default
	sun.directional_shadow_max_distance = 400.0
	sun.transform = Transform3D(Basis.looking_at(Vector3(-0.4, -1.0, -0.5), Vector3.UP), Vector3.ZERO)
	add_child(sun)

	var ground := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size = Vector2(600, 600)
	ground.mesh = plane
	var sand := StandardMaterial3D.new()
	sand.albedo_color = Color(0.72, 0.65, 0.5)
	sand.roughness = 1.0
	ground.material_override = sand
	add_child(ground)

	_camera = Camera3D.new()
	_camera.fov = 45
	add_child(_camera)
	_camera.look_at_from_position(Vector3(0, 120, 170), Vector3(0, 0, 10))

	for i in COUNT:
		var node := MoxelVolume3D.new()
		node.animation = CRITTER
		node.set_emission(EYE, 1.0)
		node.set_emission(ANTENNA, 1.0)
		node.emissive_intensity = 1.5
		node.frame = randi() % CRITTER.get_frame_count()
		node.play()
		add_child(node)
		_critters.append({
			node = node,
			angle = TAU * i / COUNT,
			radius = 30.0 + (i % 3) * 22.0,
			speed = randf_range(0.25, 0.45) * (1.0 if i % 2 else -1.0),
			solid = node.get_voxel_count(),
			state = "alive",
			t = 0.0,
		})

	_multimesh = MultiMesh.new()
	_multimesh.transform_format = MultiMesh.TRANSFORM_3D
	_multimesh.use_colors = true
	_multimesh.mesh = BoxMesh.new()
	_multimesh.instance_count = MAX_DEBRIS
	_multimesh.visible_instance_count = 0
	var debris := MultiMeshInstance3D.new()
	debris.multimesh = _multimesh
	var cubes := StandardMaterial3D.new()
	cubes.vertex_color_use_as_albedo = true
	cubes.vertex_color_is_srgb = true
	cubes.roughness = 1.0
	debris.material_override = cubes
	add_child(debris)

	var layer := CanvasLayer.new()
	_hud = Label.new()
	_hud.position = Vector2(12, 12)
	_hud.add_theme_color_override("font_color", Color(0.1, 0.1, 0.13))
	layer.add_child(_hud)
	add_child(layer)


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		shoot(event.position)
	elif event is InputEventScreenTouch and event.pressed:
		shoot(event.position)


## Fire at a point on the screen. Returns whether a critter was hit.
func shoot(screen_position: Vector2) -> bool:
	shots += 1
	var origin := _camera.project_ray_origin(screen_position)
	var direction := _camera.project_ray_normal(screen_position)
	var best := {}
	var target := {}
	for c in _critters:
		if c.state != "alive":
			continue
		var hit: Dictionary = c.node.raycast(origin, direction)
		if not hit.is_empty() and (best.is_empty() or hit.distance < best.distance):
			best = hit
			target = c
	if best.is_empty():
		return false
	var node: MoxelVolume3D = target.node
	var cell: Vector3i = best.cell
	var center := Vector3(cell) + Vector3.ONE * 0.5
	var outward: Vector3 = (node.global_basis * Vector3(best.normal)).normalized()
	_spawn_debris(node, center, outward)
	node.fill_sphere(center, BLAST, 0, true)
	node.flash(cell, Color(1.0, 0.91, 0.66), 6.0, 0.3)
	hits += 1
	if node.get_voxel_count() < target.solid * 0.6:
		target.state = "dying"
		target.t = 0.0
	return true


## The screen position of a critter's middle, for scripted shots.
func critter_screen_position(index: int) -> Vector2:
	var node: MoxelVolume3D = _critters[index].node
	return _camera.unproject_position(node.to_global(Vector3(10, 12, 8)))


func critter_state(index: int) -> String:
	return _critters[index].state


func debris_count() -> int:
	return _debris.size()


func _spawn_debris(node: MoxelVolume3D, center: Vector3, outward: Vector3) -> void:
	var origin := node.to_global(center)
	var r := ceili(BLAST)
	var c := Vector3i(center.floor())
	for z in range(c.z - r, c.z + r + 1):
		for y in range(c.y - r, c.y + r + 1):
			for x in range(c.x - r, c.x + r + 1):
				var cell := Vector3i(x, y, z)
				if (Vector3(cell) + Vector3.ONE * 0.5).distance_to(center) > BLAST or _debris.size() >= MAX_DEBRIS:
					continue
				var value := node.get_voxel(cell)
				if value == 0:
					continue
				var p := node.to_global(Vector3(cell) + Vector3.ONE * 0.5)
				var out := ((p - origin).normalized() + outward).normalized()
				_debris.append({
					p = p,
					v = out * randf_range(25, 50) + Vector3.UP * randf_range(20, 35),
					spin = Vector3(randf() - 0.5, randf() - 0.5, randf() - 0.5) * 12.0,
					basis = Basis.IDENTITY,
					life = randf_range(1.6, 2.4),
					color = node.palette[value],
				})


func _process(delta: float) -> void:
	_frame_ms.append(delta * 1000.0)
	if _frame_ms.size() > 120:
		_frame_ms.remove_at(0)
	for c in _critters:
		var node: MoxelVolume3D = c.node
		if c.state == "alive":
			c.angle += c.speed * delta * 60.0 / c.radius
		elif c.state == "dying":
			c.t += delta
			node.dissolve = c.t / 0.8
			if c.t >= 0.8:
				# back as new, somewhere else, dissolving in
				node.animation = CRITTER
				node.play()
				c.angle = randf() * TAU
				c.state = "spawning"
				c.t = 0.0
				knocked_out += 1
		elif c.state == "spawning":
			c.t += delta
			node.dissolve = 1.0 - c.t / 0.8
			if c.t >= 0.8:
				node.dissolve = 0.0
				c.state = "alive"
		_place(c)
	_update_debris(delta)
	var ms := 0.0
	for m in _frame_ms:
		ms += m
	_hud.text = "Click or tap a critter to blast it\nHits %d of %d · knocked out %d\n%d critters, %d debris · %.1f ms a frame" % [hits, shots, knocked_out, COUNT, _debris.size(), ms / maxi(1, _frame_ms.size())]


## On its circle, facing the way it walks. The node's origin is its grid's corner.
func _place(c: Dictionary) -> void:
	var node: MoxelVolume3D = c.node
	var heading := Vector3(-sin(c.angle), 0, cos(c.angle)) * signf(c.speed)
	var basis := Basis(Vector3.UP, atan2(heading.x, heading.z))
	var size := Vector3(CRITTER.grid_size)
	var center := basis * Vector3(size.x / 2.0, 0, size.z / 2.0)
	node.transform = Transform3D(basis, Vector3(cos(c.angle) * c.radius, 0, sin(c.angle) * c.radius) - center)


func _update_debris(delta: float) -> void:
	var alive: Array[Dictionary] = []
	for d in _debris:
		d.life -= delta
		if d.life > 0.0:
			alive.append(d)
	_debris = alive
	for i in _debris.size():
		var d := _debris[i]
		d.v.y -= 90.0 * delta
		d.p += d.v * delta
		if d.p.y < 0.5:
			d.p.y = 0.5
			d.v = Vector3(d.v.x * 0.7, -d.v.y * 0.35, d.v.z * 0.7)
			d.spin *= 0.7
		if d.spin.length() > 0.0:
			d.basis = Basis(d.spin.normalized(), d.spin.length() * delta) * d.basis
		var s := minf(1.0, d.life * 2.0)
		_multimesh.set_instance_transform(i, Transform3D(d.basis.scaled(Vector3.ONE * s), d.p))
		_multimesh.set_instance_color(i, d.color)
	_multimesh.visible_instance_count = _debris.size()
