@tool
## Draws a MoxelVolumeAnimation from its voxels, with no mesh: a box whose shader walks the grid
## along each pixel's ray and writes the depth of the voxel it hits. Plays the frames, swaps
## palettes, picks voxels, edits them, and dissolves, cuts away or flashes them.
##
## The node's local space is the document grid: cell (x, y, z) spans x to x + 1 on each axis, so
## the origin is the grid's corner. Scale the node to set voxels per unit. Needs Godot 4.5 or later
## and the Forward+ renderer. Give omni lights cube shadows: dual-paraboloid shadows bend vertices,
## which a ray-marched depth can't follow.
## See docs/voxel-runtime.md in the Moxel repository.
class_name MoxelVolume3D
extends MeshInstance3D

## A different frame is showing, during playback or after setting `frame`.
signal frame_changed
## Playback without `loop` reached the end of the last frame.
signal animation_finished

enum Lighting {
	## Godot's lights, shadows and ambient light, like a StandardMaterial3D.
	LIT,
	## Unlit, shaded like Moxel's viewport: face shading and voxel AO.
	FLAT,
}

## The box is drawn this much larger than the volume on each side; see voxel_volume.gdshaderinc.
const MARGIN := 0.0137
const LIT_SHADER := preload("res://addons/moxel/voxel_volume.gdshader")
const FLAT_SHADER := preload("res://addons/moxel/voxel_volume_flat.gdshader")

@export var animation: MoxelVolumeAnimation:
	set(value):
		animation = value
		_rebuild()
@export var lighting := Lighting.LIT:
	set(value):
		lighting = value
		_update_shader()
## Face shading, in FLAT lighting.
@export var shade := true:
	set(value):
		shade = value
		_param("shade", value)
## Voxel ambient occlusion. LIT, it darkens indirect light only.
@export var ambient_occlusion := true:
	set(value):
		ambient_occlusion = value
		_param("ambient_occlusion", value)
## The frame on show. Setting it moves playback to that frame's start.
@export var frame := 0:
	get:
		return _frame_shown if _frame_shown >= 0 else _start_frame
	set(value):
		_start_frame = maxi(0, value)
		if _poses.is_empty():
			return
		var i := clampi(value, 0, animation.get_frame_count() - 1)
		_time_ms = MoxelTiming.ticks_to_ms(MoxelTiming.frame_start(animation.frame_durations, i), animation.fps)
		_show(i)
## Start playing when the scene starts.
@export var autoplay := false
## Playback speed: 2 plays twice as fast.
@export var speed_scale := 1.0
## Wrap around after the last frame, rather than stop on it.
@export var loop := true

@export_group("Effects")
## 0 to 1: the share of voxels gone, picked by a hash of each grid cell, so the same cells go first
## every time. Dissolved voxels cast no shadow and can't be hit.
@export_range(0.0, 1.0) var dissolve := 0.0:
	set(value):
		dissolve = clampf(value, 0.0, 1.0)
		_param("dissolve", dissolve)
## How far ahead of `dissolve` voxels glow in `dissolve_color` before they go.
@export var dissolve_edge := 0.04:
	set(value):
		dissolve_edge = maxf(0.0, value)
		_param("dissolve_edge", dissolve_edge)
@export var dissolve_color := Color(1.0, 0.69, 0.29):
	set(value):
		dissolve_color = value
		_param("dissolve_color", value)
## Hide the voxels whose centers are above `clip_plane` (where Plane.distance_to > 0), in grid
## coordinates. The ray carries on, so the model looks solid inside.
@export var clip_enabled := false:
	set(value):
		clip_enabled = value
		_param("clip_enabled", value)
@export var clip_plane := Plane(Vector3.UP, 0.0):
	set(value):
		clip_plane = value
		_param("clip_plane", Vector4(value.normal.x, value.normal.y, value.normal.z, -value.d))
## Scales glowing palette entries in LIT lighting. Raise it for glow.
@export var emissive_intensity := 1.0:
	set(value):
		emissive_intensity = maxf(0.0, value)
		_param("emissive_intensity", emissive_intensity)

var playing := false:
	get:
		return _playing
## The palette on show, sRGB; index 0 is empty. Starts as the animation's; set it to swap.
var palette: PackedColorArray:
	get:
		return _colors
	set(value):
		_colors = value.duplicate()
		_colors.resize(256)
		_write_palette()

var _time_ms := 0.0
var _playing := false
var _frame_shown := -1
var _start_frame := 0
var _flash_amount := 0.0
var _flash_fade := 0.0
var _colors := PackedColorArray()
var _emission := PackedFloat32Array()
var _palette_texture: ImageTexture
var _material: ShaderMaterial
# One per pose: { size, offset, data, texture, box, owned }. Data and texture come from the
# animation, shared, until this node edits the pose.
var _poses: Array[Dictionary] = []


func _init() -> void:
	_emission.resize(256)
	_material = ShaderMaterial.new()
	_material.shader = LIT_SHADER
	material_override = _material


# The node manages its own mesh, material and bounds; scenes don't store them.
func _validate_property(property: Dictionary) -> void:
	if property.name in ["mesh", "material_override", "custom_aabb"]:
		property.usage = PROPERTY_USAGE_NONE


func _ready() -> void:
	_rebuild()
	if autoplay and not Engine.is_editor_hint():
		play()


func _process(delta: float) -> void:
	if _flash_amount > 0.0:
		_flash_amount = maxf(0.0, _flash_amount - delta * _flash_fade)
		_param("flash_amount", _flash_amount)
	if Engine.is_editor_hint() or not _playing:
		return
	advance(delta)


## Start or resume playback.
func play() -> void:
	if not animation:
		return
	var length := _length()
	if not loop and _time_ms >= length:
		_time_ms = 0.0
	_playing = animation.get_frame_count() > 1


func pause() -> void:
	_playing = false


## Pause and go back to the first frame.
func stop() -> void:
	_playing = false
	frame = 0


## Move playback on by `seconds` of real time. Called for you every frame while playing.
func advance(seconds: float) -> void:
	if not animation or not _playing:
		return
	_time_ms += seconds * 1000.0 * speed_scale
	var length := _length()
	if not loop and _time_ms >= length:
		_time_ms = length
		_playing = false
		_show(animation.get_frame_count() - 1)
		animation_finished.emit()
		return
	if loop and _time_ms >= length:
		_time_ms = fmod(_time_ms, length)
	_show(MoxelTiming.frame_at(animation.frame_durations, animation.fps, _time_ms, loop))


## Light up the voxels around a cell, fading out over `duration` seconds: a hit.
func flash(cell: Vector3i, color := Color.WHITE, radius := 3.0, duration := 0.25) -> void:
	_param("flash_center", Vector3(cell) + Vector3.ONE * 0.5)
	_param("flash_color", color)
	_param("flash_radius", radius)
	_flash_amount = 1.0
	_param("flash_amount", 1.0)
	_flash_fade = 1.0 / duration if duration > 0.0 else INF


## Make a palette entry glow, 0 to 1. LIT, it adds its color as emission; FLAT, it ignores shading.
func set_emission(index: int, strength: float) -> void:
	if index < 1 or index > 255:
		return
	_emission[index] = clampf(strength, 0.0, 1.0)
	_write_palette()


func get_emission(index: int) -> float:
	return _emission[index]


## The shader's random number for a grid cell, in [0, 1) in steps of 1/65536. Dissolve hides a cell
## when this is below `dissolve`. The same as voxelHash in Moxel's three.js runtime.
static func voxel_hash(cell: Vector3i) -> float:
	var x := (cell.x * 1597334673) & 0xFFFFFFFF
	var y := (cell.y * 3812015801) & 0xFFFFFFFF
	var z := (cell.z * 2798796415) & 0xFFFFFFFF
	var h := ((x ^ y ^ z) * 1597334677) & 0xFFFFFFFF
	return float(h >> 16) / 65536.0


## Whether a grid cell is dissolved or cut away, as the shader decides.
func is_hidden(cell: Vector3i) -> bool:
	if dissolve > 0.0 and voxel_hash(cell) < dissolve:
		return true
	return clip_enabled and clip_plane.distance_to(Vector3(cell) + Vector3.ONE * 0.5) > 0.0


## The palette index at a grid cell in the frame on show, or 0.
func get_voxel(cell: Vector3i) -> int:
	var pose := _pose()
	if pose.is_empty():
		return 0
	var i := _index(pose, cell)
	return pose.data[i] if i >= 0 else 0


## How many solid voxels the pose on show has.
func get_voxel_count() -> int:
	var pose := _pose()
	if pose.is_empty():
		return 0
	return (pose.data as PackedByteArray).size() - (pose.data as PackedByteArray).count(0)


## Set a grid cell of the pose on show (0 empties it). Frames showing the same pose change too;
## cells outside the pose's crop are ignored. Other nodes sharing the animation are unaffected.
func set_voxel(cell: Vector3i, value: int) -> void:
	_fill([_current_pose()], func(c: Vector3i) -> bool: return c == cell, value)


## Set every cell from `from` to `to` (inclusive) to `value`. Returns how many changed. With
## `all_frames`, every pose changes: the same grid cells, which suits parts that hold still.
func fill_box(from: Vector3i, to: Vector3i, value: int, all_frames := false) -> int:
	var lo := from.min(to)
	var hi := from.max(to)
	return _fill(_targets(all_frames), func(c: Vector3i) -> bool:
		return c.x >= lo.x and c.y >= lo.y and c.z >= lo.z and c.x <= hi.x and c.y <= hi.y and c.z <= hi.z, value)


## Set every cell whose center is within `radius` of `center` (grid coordinates) to `value`.
func fill_sphere(center: Vector3, radius: float, value: int, all_frames := false) -> int:
	var r2 := radius * radius
	return _fill(_targets(all_frames), func(c: Vector3i) -> bool:
		return (Vector3(c) + Vector3.ONE * 0.5).distance_squared_to(center) <= r2, value)


## The first shown voxel along a ray in world space, or an empty Dictionary. Hit: cell and normal
## (grid), value (palette index), position (world) and distance (world).
func raycast(origin: Vector3, direction: Vector3, max_distance := INF) -> Dictionary:
	var pose := _pose()
	if pose.is_empty() or direction.is_zero_approx():
		return {}
	# outside the tree, there is only the node's own transform
	var to_world := global_transform if is_inside_tree() else transform
	var to_local := to_world.affine_inverse()
	var local_origin := to_local * origin
	var local_dir := (to_local.basis * direction).normalized()
	var size: Vector3i = pose.size
	var offset: Vector3i = pose.offset
	var data: PackedByteArray = pose.data
	var hit := _march(local_origin - Vector3(offset), local_dir, size, func(c: Vector3i) -> bool:
		return data[c.x + size.x * (c.y + size.y * c.z)] != 0 and not is_hidden(c + offset))
	if hit.is_empty():
		return {}
	var position := to_world * (local_origin + local_dir * float(hit.t))
	var distance := origin.distance_to(position)
	if distance > max_distance:
		return {}
	var cell: Vector3i = hit.cell + offset
	return { cell = cell, normal = hit.normal, value = get_voxel(cell), position = position, distance = distance }


# Amanatides & Woo, as raycastVolume in Moxel's core: the first cell where `solid` holds.
static func _march(origin: Vector3, dir: Vector3, size: Vector3i, solid: Callable) -> Dictionary:
	var t_min := 0.0
	var t_max := INF
	var enter_axis := -1
	for a in 3:
		if absf(dir[a]) < 1e-12:
			if origin[a] < 0.0 or origin[a] > size[a]:
				return {}
			continue
		var t0 := (0.0 - origin[a]) / dir[a]
		var t1 := (size[a] - origin[a]) / dir[a]
		if t0 > t1:
			var swap := t0
			t0 = t1
			t1 = swap
		if t0 > t_min:
			t_min = t0
			enter_axis = a
		t_max = minf(t_max, t1)
		if t_min > t_max:
			return {}
	var p := origin + dir * (t_min + 1e-6)
	var cell := Vector3i(clampi(floori(p.x), 0, size.x - 1), clampi(floori(p.y), 0, size.y - 1), clampi(floori(p.z), 0, size.z - 1))
	var step := Vector3i(1 if dir.x > 0 else -1, 1 if dir.y > 0 else -1, 1 if dir.z > 0 else -1)
	var t_delta := Vector3(absf(1.0 / dir.x) if dir.x != 0 else INF, absf(1.0 / dir.y) if dir.y != 0 else INF, absf(1.0 / dir.z) if dir.z != 0 else INF)
	var t_next := Vector3.ZERO
	for a in 3:
		t_next[a] = ((cell[a] + (1 if dir[a] > 0 else 0)) - origin[a]) / dir[a] if dir[a] != 0 else INF
	var axis := enter_axis
	var t := t_min
	while true:
		if solid.call(cell):
			var normal := Vector3i.ZERO
			if axis < 0:
				# started inside a solid cell: face the ray along its dominant axis
				var d := dir.abs()
				axis = 0 if d.x >= d.y and d.x >= d.z else (1 if d.y >= d.z else 2)
			normal[axis] = -step[axis]
			return { cell = cell, normal = normal, t = t }
		axis = 0 if t_next.x < t_next.y and t_next.x < t_next.z else (1 if t_next.y < t_next.z else 2)
		cell[axis] += step[axis]
		t = t_next[axis]
		t_next[axis] += t_delta[axis]
		if cell[axis] < 0 or cell[axis] >= size[axis]:
			return {}
	return {}


func _length() -> float:
	return MoxelTiming.ticks_to_ms(MoxelTiming.total_ticks(animation.frame_durations), animation.fps)


func _param(name: String, value: Variant) -> void:
	if _material:
		_material.set_shader_parameter(name, value)


func _update_shader() -> void:
	if not _material:
		return
	_material.shader = LIT_SHADER if lighting == Lighting.LIT else FLAT_SHADER
	# Parameters set on the material survive the shader change.


func _rebuild() -> void:
	_poses.clear()
	_frame_shown = -1
	if not animation or animation.get_frame_count() == 0:
		mesh = null
		return
	for i in animation.get_pose_count():
		var size := animation.pose_sizes[i]
		var box := BoxMesh.new()
		box.size = Vector3(size) + Vector3.ONE * 2.0 * MARGIN
		_poses.append({ size = size, offset = animation.pose_offsets[i], data = animation.pose_data[i], texture = null, box = box, owned = false })
	_colors = animation.colors.duplicate()
	_colors.resize(256)
	_write_palette()
	for name in ["shade", "ambient_occlusion", "dissolve", "dissolve_edge", "dissolve_color", "clip_enabled", "clip_plane", "emissive_intensity"]:
		set(name, get(name))
	var i := clampi(_start_frame, 0, animation.get_frame_count() - 1)
	_time_ms = MoxelTiming.ticks_to_ms(MoxelTiming.frame_start(animation.frame_durations, i), animation.fps)
	_show(i, true)


func _show(i: int, force := false) -> void:
	if _poses.is_empty():
		return
	var changed := i != _frame_shown
	if not changed and not force:
		return
	_frame_shown = i
	var index := animation.frame_poses[i]
	var pose := _poses[index]
	if not pose.texture:
		pose.texture = animation.get_pose_texture(index)
	mesh = pose.box
	custom_aabb = AABB(Vector3(pose.offset) - Vector3.ONE * MARGIN, Vector3(pose.size) + Vector3.ONE * 2.0 * MARGIN)
	_param("volume", pose.texture)
	_param("size", Vector3(pose.size))
	_param("offset", Vector3(pose.offset))
	if changed and not force:
		frame_changed.emit()


func _current_pose() -> int:
	return animation.frame_poses[_frame_shown] if animation and _frame_shown >= 0 else -1


func _pose() -> Dictionary:
	var i := _current_pose()
	return _poses[i] if i >= 0 else {}


func _targets(all_frames: bool) -> Array:
	if all_frames:
		return range(_poses.size())
	return [_current_pose()]


func _index(pose: Dictionary, cell: Vector3i) -> int:
	var c: Vector3i = cell - pose.offset
	var s: Vector3i = pose.size
	if c.x < 0 or c.y < 0 or c.z < 0 or c.x >= s.x or c.y >= s.y or c.z >= s.z:
		return -1
	return c.x + s.x * (c.y + s.y * c.z)


func _fill(targets: Array, inside: Callable, value: int) -> int:
	var changed := 0
	for index in targets:
		if index < 0:
			continue
		var pose := _poses[index]
		var s: Vector3i = pose.size
		var o: Vector3i = pose.offset
		var touched := false
		for z in s.z:
			for y in s.y:
				for x in s.x:
					var i := x + s.x * (y + s.y * z)
					if pose.data[i] == value or not inside.call(Vector3i(x, y, z) + o):
						continue
					if not pose.owned:
						# copy on write: the animation, and other nodes showing it, keep theirs
						pose.data = pose.data.duplicate()
						pose.owned = true
					pose.data[i] = value
					changed += 1
					touched = true
		if touched:
			if pose.texture and pose.texture != animation.get_pose_texture(index):
				pose.texture.update(MoxelVolumeAnimation.slices(s, pose.data))
			else:
				pose.texture = MoxelVolumeAnimation.make_texture(s, pose.data)
			if index == _current_pose():
				_param("volume", pose.texture)
	return changed


func _write_palette() -> void:
	if _colors.size() < 256:
		return
	var image := Image.create_empty(256, 1, false, Image.FORMAT_RGBA8)
	for i in 256:
		var c := _colors[i]
		image.set_pixel(i, 0, Color(c.r, c.g, c.b, _emission[i]))
	if _palette_texture:
		_palette_texture.update(image)
	else:
		_palette_texture = ImageTexture.create_from_image(image)
	_param("palette", _palette_texture)
