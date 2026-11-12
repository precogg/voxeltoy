@tool
class_name MoxelGLTFMarkers
extends GLTFDocumentExtension
## Voxeltoy's markers in an imported .glb: named empties whose glTF extras say what they are
## (`extras.voxeltoy`, or the legacy `extras.moxel`: marker, role, shape, size, options, data). Godot keeps extras as each node's
## "extras" metadata; this turns markers into what their role asks for:
##
## - "collision": a StaticBody3D with a CollisionShape3D of the marker's shape.
## - "hitbox", "hurtbox": an Area3D with a CollisionShape3D, in the group of that name.
## - "mount" and other roles: left as the empty, for attaching things to.
##
## Every marker node gets "moxel_marker" metadata (the extras) and joins the group "moxel_markers".
## The plugin registers this; a game that loads .glb files at run time can register it too, with
## `GLTFDocument.register_gltf_document_extension(MoxelGLTFMarkers.new())`.


func _import_post(_state: GLTFState, root: Node) -> Error:
	var found: Array[Node3D] = []
	_collect(root, found)
	for node in found:
		_apply(node, root)
	return OK


func _collect(node: Node, out: Array[Node3D]) -> void:
	if node is Node3D and _marker_of(node) != null:
		out.append(node)
	for child in node.get_children():
		_collect(child, out)


## A node's Moxel marker extras, or null.
static func _marker_of(node: Node) -> Variant:
	if not node.has_meta("extras"):
		return null
	var extras: Variant = node.get_meta("extras")
	if not extras is Dictionary:
		return null
	var moxel: Variant = extras.get("voxeltoy", extras.get("moxel", null))
	if not moxel is Dictionary or not moxel.has("marker"):
		return null
	return moxel


func _apply(node: Node3D, root: Node) -> void:
	var moxel: Dictionary = _marker_of(node)
	node.set_meta("moxel_marker", moxel)
	node.add_to_group("moxel_markers", true)
	var role: Variant = moxel.get("role")
	if role != "collision" and role != "hitbox" and role != "hurtbox":
		return
	var shape := _shape(moxel)
	if shape == null:
		return
	var body: CollisionObject3D
	if role == "collision":
		body = StaticBody3D.new()
		body.name = "%s body" % node.name
	else:
		body = Area3D.new()
		body.name = "%s area" % node.name
		body.add_to_group(role, true)
	var collider := CollisionShape3D.new()
	collider.name = "Shape"
	collider.shape = shape.shape
	collider.transform = shape.transform
	body.add_child(collider)
	node.add_child(body)
	body.owner = root
	collider.owner = root


## A collision shape for a volume marker, and how to place it in the marker's node (whose origin is
## the volume's center). Shapes that Godot has no primitive for get their box.
static func _shape(moxel: Dictionary) -> Variant:
	var kind: String = str(moxel.get("shape", "point"))
	var raw: Variant = moxel.get("size")
	if kind == "point" or not raw is Array or raw.size() != 3:
		return null
	var size := Vector3(float(raw[0]), float(raw[1]), float(raw[2]))
	var options: Dictionary = moxel.get("options", {}) if moxel.get("options") is Dictionary else {}
	# which way round shapes point: Moxel's `up` is { axis: 0-2, sign }
	var axis := 1
	var up: Variant = options.get("up")
	if up is Dictionary and up.has("axis"):
		axis = clampi(int(up["axis"]), 0, 2)
	var along := size[axis]
	var across := minf(size[(axis + 1) % 3], size[(axis + 2) % 3])
	# Godot's cylinders and capsules stand along Y: turn them onto the marker's axis
	var turn := Transform3D.IDENTITY
	if axis == 0:
		turn = Transform3D(Basis(Vector3.BACK, PI / 2), Vector3.ZERO)
	elif axis == 2:
		turn = Transform3D(Basis(Vector3.RIGHT, PI / 2), Vector3.ZERO)
	match kind:
		"sphere":
			var sphere := SphereShape3D.new()
			sphere.radius = minf(size.x, minf(size.y, size.z)) / 2.0
			return {"shape": sphere, "transform": Transform3D.IDENTITY}
		"cylinder":
			var cylinder := CylinderShape3D.new()
			cylinder.height = along
			cylinder.radius = across / 2.0
			return {"shape": cylinder, "transform": turn}
		"capsule":
			var capsule := CapsuleShape3D.new()
			capsule.radius = across / 2.0
			capsule.height = maxf(along, across)
			return {"shape": capsule, "transform": turn}
		_:
			var box := BoxShape3D.new()
			box.size = size
			return {"shape": box, "transform": Transform3D.IDENTITY}
