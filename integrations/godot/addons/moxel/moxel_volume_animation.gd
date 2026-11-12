@tool
## A Moxel voxel volumes export: the document grid, a 256-color palette, each distinct pose's
## voxels (cropped, with where it sits in the grid), and the frames that show them. Import a
## .moxelvol file to get one, or load a folder or zip at run time with `load_file`.
## See docs/voxel-runtime.md in the Moxel repository.
class_name MoxelVolumeAnimation
extends Resource

## The document grid, in voxels.
@export var grid_size := Vector3i.ONE
## Ticks per second; a frame lasts `frame_durations[i]` ticks.
@export var fps := 12
## Palette colors, sRGB; index 0 is empty.
@export var colors := PackedColorArray()
## Each pose's size and offset in the grid, and its voxels: x-major palette indices,
## x + size.x * (y + size.y * z), 0 = empty.
@export var pose_sizes: Array[Vector3i] = []
@export var pose_offsets: Array[Vector3i] = []
@export var pose_data: Array[PackedByteArray] = []
## The frames in order: an id, a duration in ticks, and the pose shown.
@export var frame_ids := PackedStringArray()
@export var frame_durations := PackedInt32Array()
@export var frame_poses := PackedInt32Array()

# Built on demand and shared by every node that shows this animation.
var _textures: Array[ImageTexture3D] = []


func get_pose_count() -> int:
	return pose_data.size()


func get_frame_count() -> int:
	return frame_poses.size()


## The R8 3D texture of a pose, as the voxel volume shaders read it.
func get_pose_texture(pose: int) -> ImageTexture3D:
	if _textures.size() != pose_data.size():
		_textures.resize(pose_data.size())
	if not _textures[pose]:
		_textures[pose] = make_texture(pose_sizes[pose], pose_data[pose])
	return _textures[pose]


## An R8 3D texture of x-major voxels. Moxel's byte order is the texture's: each z is one slice.
static func make_texture(size: Vector3i, data: PackedByteArray) -> ImageTexture3D:
	var texture := ImageTexture3D.new()
	texture.create(Image.FORMAT_R8, size.x, size.y, size.z, false, slices(size, data))
	return texture


static func slices(size: Vector3i, data: PackedByteArray) -> Array[Image]:
	var out: Array[Image] = []
	var n := size.x * size.y
	for z in size.z:
		out.append(Image.create_from_data(size.x, size.y, false, Image.FORMAT_R8, data.slice(z * n, (z + 1) * n)))
	return out


## Load from a .voxeltoyvol, legacy .moxelvol, or .zip export, or a folder holding volumes.json.
static func load_file(path: String) -> MoxelVolumeAnimation:
	if DirAccess.dir_exists_absolute(path):
		return parse(func(file: String) -> PackedByteArray: return FileAccess.get_file_as_bytes(path.path_join(file)))
	var zip := ZIPReader.new()
	if zip.open(path) != OK:
		push_error("Voxeltoy: couldn't open %s" % path)
		return null
	var animation := parse(func(file: String) -> PackedByteArray: return zip.read_file(file))
	zip.close()
	return animation


## Build from a function that returns a file's bytes by its name in the manifest.
static func parse(read: Callable) -> MoxelVolumeAnimation:
	var manifest = JSON.parse_string((read.call("volumes.json") as PackedByteArray).get_string_from_utf8())
	var format := str(manifest.get("format", "")) if typeof(manifest) == TYPE_DICTIONARY else ""
	if typeof(manifest) != TYPE_DICTIONARY or (format != "voxeltoy-volumes" and format != "moxel-volumes"):
		push_error("Voxeltoy: not a voxel volumes manifest")
		return null
	if int(manifest.get("version", 0)) != 1:
		push_error("Voxeltoy: voxel volumes version %s is newer than this reader" % manifest.get("version"))
		return null
	var out := MoxelVolumeAnimation.new()
	out.resource_name = str(manifest.get("name", ""))
	out.fps = int(manifest.fps)
	out.grid_size = _vec3i(manifest.size)

	var palette := Image.new()
	if palette.load_png_from_buffer(read.call(manifest.palette)) != OK:
		push_error("Voxeltoy: couldn't read the palette")
		return null
	palette.convert(Image.FORMAT_RGBA8)
	out.colors.resize(256)
	for i in 256:
		var c := palette.get_pixel(i, 0) if i < palette.get_width() else Color.BLACK
		out.colors[i] = Color(c.r, c.g, c.b)

	for v in manifest.volumes:
		var size := _vec3i(v.size)
		var offset := _vec3i(v.offset)
		if size.x < 1 or size.y < 1 or size.z < 1 or (offset + size).x > out.grid_size.x or (offset + size).y > out.grid_size.y or (offset + size).z > out.grid_size.z:
			push_error("Voxeltoy: %s does not fit in the grid" % v.file)
			return null
		var image := Image.new()
		if image.load_png_from_buffer(read.call(v.file)) != OK:
			push_error("Voxeltoy: couldn't read %s" % v.file)
			return null
		# Grayscale PNGs load as L8; the value is the first channel either way.
		image.convert(Image.FORMAT_R8)
		var columns := int(v.get("columns", ceili(sqrt(size.z))))
		if image.get_width() < size.x * columns or image.get_height() < size.y * ceili(float(size.z) / columns):
			push_error("Voxeltoy: %s is too small for its voxels" % v.file)
			return null
		var pixels := image.get_data()
		var data := PackedByteArray()
		for z in size.z:
			var left := (z % columns) * size.x
			var top := (z / columns) * size.y
			for y in size.y:
				var from := left + (top + y) * image.get_width()
				data.append_array(pixels.slice(from, from + size.x))
		out.pose_sizes.append(size)
		out.pose_offsets.append(offset)
		out.pose_data.append(data)

	for f in manifest.frames:
		var pose := int(f.volume)
		if pose < 0 or pose >= out.pose_data.size():
			push_error("Voxeltoy: a frame refers to a missing volume")
			return null
		out.frame_ids.append(str(f.get("id", "")))
		out.frame_durations.append(maxi(1, int(f.duration)))
		out.frame_poses.append(pose)
	return out


static func _vec3i(a: Array) -> Vector3i:
	return Vector3i(int(a[0]), int(a[1]), int(a[2]))
