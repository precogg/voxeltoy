## Tests for addons/moxel. Run from integrations/godot, after `godot --headless --path . --import`:
##
##   xvfb-run -a godot --path . -s spike/tests.gd
##
## Exits with 1 if any check fails. Textures need a real renderer, hence the window.
extends SceneTree

## voxelHash from Moxel's three.js runtime, for the same cells.
const HASHES := [[0, 0, 0, 0.0], [1, 2, 3, 0.06396484375], [255, 17, 9, 0.090728759765625], [31, 31, 31, 0.2104644775390625], [5, 0, 6, 0.201324462890625], [200, 255, 128, 0.740631103515625]]

var failures := 0


func check(ok: bool, what: String) -> void:
	if ok:
		print("  ok   ", what)
	else:
		failures += 1
		printerr("  FAIL ", what)


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	_hash()
	_timing()
	var ball := MoxelVolumeAnimation.load_file(ProjectSettings.globalize_path("res://fixtures/ball"))
	var critter := MoxelVolumeAnimation.load_file(ProjectSettings.globalize_path("res://fixtures/critter"))
	_reading(ball, critter)
	_godot_importer(ball)
	await _playback(critter)
	_edits(critter)
	_picking(ball)
	_effects(ball)
	print("%d failed" % failures if failures else "all passed")
	quit(1 if failures else 0)


func _hash() -> void:
	print("hash")
	for c in HASHES:
		check(MoxelVolume3D.voxel_hash(Vector3i(c[0], c[1], c[2])) == c[3], "voxel_hash(%d, %d, %d) is three.js's %s" % c)


func _timing() -> void:
	print("timing")
	var d := PackedInt32Array([2, 1, 1])
	check(MoxelTiming.frame_at(d, 10, 150) == 0 and MoxelTiming.frame_at(d, 10, 250) == 1 and MoxelTiming.frame_at(d, 10, 350) == 2, "holds: 2, 1, 1 ticks at 10 fps")
	check(MoxelTiming.frame_at(d, 10, 450) == 0, "loops")
	check(MoxelTiming.frame_at(d, 10, 450, false) == 2, "stops on the last frame without loop")
	check(MoxelTiming.frame_start(d, 2) == 3 and MoxelTiming.total_ticks(d) == 4, "starts and total")


func _count(data: PackedByteArray) -> int:
	var n := 0
	for b in data:
		if b != 0:
			n += 1
	return n


func _reading(ball: MoxelVolumeAnimation, critter: MoxelVolumeAnimation) -> void:
	print("reading")
	check(ball.grid_size == Vector3i(32, 32, 32) and ball.get_frame_count() == 8 and ball.get_pose_count() == 8, "ball: 32³, 8 frames, 8 poses")
	check(ball.pose_offsets[0] == Vector3i(5, 0, 6) and ball.pose_sizes[0] == Vector3i(22, 25, 20), "ball pose 0 is cropped and placed")
	check(_count(ball.pose_data[0]) == 6112, "ball pose 0 has its 6112 voxels")
	check(critter.get_frame_count() == 4 and critter.get_pose_count() == 3 and critter.frame_poses[3] == critter.frame_poses[1], "critter: 4 frames share 3 poses")
	var imported = load("res://demo/critter.moxelvol")
	check(imported is MoxelVolumeAnimation, "the import plugin turns a .moxelvol into a MoxelVolumeAnimation")
	if imported is MoxelVolumeAnimation:
		check(imported.pose_data == critter.pose_data and imported.frame_durations == critter.frame_durations and imported.colors == critter.colors, "and it holds what the folder holds")


## Godot's own layered importer, Lossless with no mipmaps, gives the same bytes as the decoder.
func _godot_importer(ball: MoxelVolumeAnimation) -> void:
	print("Godot's 3D texture importer")
	var texture = load("res://spike/importer/ball-volume-01.png")
	check(texture is Texture3D, "imports the volume PNG as a Texture3D")
	if not texture is Texture3D:
		return
	var layers: Array[Image] = texture.get_data()
	var size := ball.pose_sizes[0]
	check(texture.get_width() == size.x and texture.get_height() == size.y and layers.size() == size.z, "its size is the pose's")
	var same := true
	for z in mini(layers.size(), size.z):
		var layer := layers[z]
		layer.convert(Image.FORMAT_R8)
		var n := size.x * size.y
		if layer.get_data() != ball.pose_data[0].slice(z * n, (z + 1) * n):
			same = false
	check(same, "every slice's bytes equal the decoder's")


func _playback(critter: MoxelVolumeAnimation) -> void:
	print("playback")
	var node := MoxelVolume3D.new()
	node.animation = critter
	root.add_child(node)
	var changes := [0]
	node.frame_changed.connect(func() -> void: changes[0] += 1)
	# 8 fps, one tick each: 125 ms a frame, 500 ms a loop
	node.play()
	node.advance(0.13)
	check(node.frame == 1, "advances by the frame duration")
	node.advance(0.25)
	check(node.frame == 3, "skips poses when an update is late")
	node.advance(0.13)
	check(node.frame == 0, "loops")
	check(changes[0] == 3, "frame_changed fires on each change")
	node.loop = false
	node.speed_scale = 2.0
	var finished := [0]
	node.animation_finished.connect(func() -> void: finished[0] += 1)
	node.advance(1.0)
	check(node.frame == 3 and not node.playing and finished[0] == 1, "without loop, stops on the last frame and says so")
	node.frame = 2
	check(node.frame == 2, "frame can be set")
	node.queue_free()
	await process_frame


func _edits(critter: MoxelVolumeAnimation) -> void:
	print("edits")
	var a := MoxelVolume3D.new()
	var b := MoxelVolume3D.new()
	a.animation = critter
	b.animation = critter
	var cell := Vector3i(9, 10, 8)
	var before := a.get_voxel(cell)
	check(before != 0, "a body voxel is solid")
	a.set_voxel(cell, 0)
	check(a.get_voxel(cell) == 0, "set_voxel changes this node")
	check(b.get_voxel(cell) == before, "but not another node showing the same animation")
	check(critter.pose_data[critter.frame_poses[0]] != PackedByteArray() and _count(critter.pose_data[0]) == 2427, "or the animation")
	var changed := a.fill_sphere(Vector3(9.5, 12.5, 8.5), 2.0, 0, true)
	a.frame = 2
	check(changed > 0 and a.get_voxel(Vector3i(9, 12, 8)) == 0, "fill_sphere with all_frames reaches the other poses")
	check(a.fill_box(Vector3i(0, 0, 0), Vector3i(19, 21, 15), 0) > 0 and a.get_voxel(Vector3i(9, 15, 8)) == 0, "fill_box empties a box")
	a.free()
	b.free()


func _picking(ball: MoxelVolumeAnimation) -> void:
	print("picking")
	var node := MoxelVolume3D.new()
	node.animation = ball
	root.add_child(node)
	node.position = Vector3(100, 0, 0)
	node.scale = Vector3.ONE * 0.5
	# Straight down the column x = 15, z = 15, from above: the ball's top in frame 0.
	var hit := node.raycast(Vector3(100 + 15.5 * 0.5, 50, 15.5 * 0.5), Vector3.DOWN)
	check(not hit.is_empty() and hit.normal == Vector3i(0, 1, 0), "hits a top face")
	if not hit.is_empty():
		var c: Vector3i = hit.cell
		check(c.x == 15 and c.z == 15 and node.get_voxel(c + Vector3i.UP) == 0 and hit.value == node.get_voxel(c), "the highest solid cell of the column")
		check(is_equal_approx(hit.position.y, (c.y + 1) * 0.5) and is_equal_approx(hit.distance, 50 - (c.y + 1) * 0.5), "at its face, in world units")
	check(node.raycast(Vector3(100 + 0.25, 50, 0.25), Vector3.DOWN).is_empty(), "misses an empty column")
	node.queue_free()


func _effects(ball: MoxelVolumeAnimation) -> void:
	print("effects")
	var node := MoxelVolume3D.new()
	node.animation = ball
	var down := func() -> Dictionary: return node.raycast(Vector3(15.5, 50, 15.5), Vector3.DOWN)
	var top: Vector3i = down.call().cell
	node.dissolve = 1.0
	check(down.call().is_empty(), "fully dissolved voxels can't be hit")
	node.dissolve = 0.5
	var first_hidden := []
	for y in 32:
		if node.is_hidden(Vector3i(15, y, 15)):
			first_hidden.append(y)
	node.dissolve = 0.25
	var subset := true
	for y in 32:
		if node.is_hidden(Vector3i(15, y, 15)) and not y in first_hidden:
			subset = false
	check(subset, "the same cells go first")
	node.dissolve = 0.0
	node.clip_enabled = true
	node.clip_plane = Plane(Vector3.UP, top.y)  # hides centers above y = top
	check(down.call().cell.y == top.y - 1 or down.call().cell.y < top.y, "a cutaway plane hides the cells above it")
	node.clip_enabled = false
	var colors := ball.colors.duplicate()
	colors[1] = Color.RED
	node.palette = colors
	check(node.palette[1] == Color.RED and ball.colors[1] != Color.RED, "palette swaps stay on the node")
	node.set_emission(1, 1.0)
	check(node.get_emission(1) == 1.0, "emission is kept per entry")
	node.flash(top, Color.WHITE, 3.0, 0.5)
	node._process(0.25)
	check(is_equal_approx(node._flash_amount, 0.5), "a flash fades as time passes")
	node.free()
