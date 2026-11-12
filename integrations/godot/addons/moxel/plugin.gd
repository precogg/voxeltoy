@tool
extends EditorPlugin

var _importer: EditorImportPlugin
var _markers: GLTFDocumentExtension


func _enter_tree() -> void:
	_importer = preload("res://addons/moxel/import_volumes.gd").new()
	add_import_plugin(_importer)
	# markers in imported .glb files become colliders and areas (moxel_markers.gd)
	_markers = preload("res://addons/moxel/moxel_markers.gd").new()
	GLTFDocument.register_gltf_document_extension(_markers)


func _exit_tree() -> void:
	remove_import_plugin(_importer)
	_importer = null
	GLTFDocument.unregister_gltf_document_extension(_markers)
	_markers = null
