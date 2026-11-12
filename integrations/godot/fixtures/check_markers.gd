extends SceneTree
## Imports a Moxel scene .glb with the marker extension and prints what it made: each node's type,
## role and world position. Run: godot --headless --path integrations/godot --script res://fixtures/check_markers.gd -- <file.glb>


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		push_error("Pass a .glb after --")
		quit(1)
		return
	var ext := preload("res://addons/moxel/moxel_markers.gd").new()
	GLTFDocument.register_gltf_document_extension(ext)
	var doc := GLTFDocument.new()
	var state := GLTFState.new()
	var err := doc.append_from_file(args[0], state)
	if err != OK:
		push_error("Couldn't read %s: %s" % [args[0], err])
		quit(1)
		return
	var scene := doc.generate_scene(state)
	_print(scene, 0)
	scene.free()
	quit(0)


## The node's transform in the scene, without the scene tree (this runs before it starts).
func _world(node: Node3D) -> Transform3D:
	var t := node.transform
	var at := node.get_parent()
	while at is Node3D:
		t = (at as Node3D).transform * t
		at = at.get_parent()
	return t


func _print(node: Node, depth: int) -> void:
	var line := "  ".repeat(depth) + "%s (%s)" % [node.name, node.get_class()]
	if node is Node3D:
		var t := _world(node as Node3D)
		line += " at (%.2f, %.2f, %.2f)" % [t.origin.x, t.origin.y, t.origin.z]
		var up := t.basis.y.normalized()
		line += " up (%.0f, %.0f, %.0f)" % [up.x, up.y, up.z]
	if node.has_meta("moxel_marker"):
		line += " marker role=%s" % node.get_meta("moxel_marker").get("role")
	if node is CollisionShape3D:
		line += " shape=%s" % (node as CollisionShape3D).shape.get_class()
		var s: Shape3D = (node as CollisionShape3D).shape
		if s is BoxShape3D:
			line += " size=%s" % (s as BoxShape3D).size
		if s is CapsuleShape3D:
			line += " r=%.2f h=%.2f" % [(s as CapsuleShape3D).radius, (s as CapsuleShape3D).height]
	if not node.get_groups().is_empty():
		line += " groups=%s" % [node.get_groups()]
	print(line)
	for child in node.get_children():
		_print(child, depth + 1)
