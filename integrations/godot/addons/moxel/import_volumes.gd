@tool
## Imports a Voxeltoy voxel volumes export (.voxeltoyvol, or a legacy .moxelvol: a zip of volumes.json and PNGs) as a
## MoxelVolumeAnimation, for MoxelVolume3D.
extends EditorImportPlugin


func _get_importer_name() -> String:
	return "moxel.volumes"


func _get_visible_name() -> String:
	return "Voxeltoy voxel volumes"


func _get_recognized_extensions() -> PackedStringArray:
	return ["voxeltoyvol", "moxelvol"]


func _get_save_extension() -> String:
	return "res"


func _get_resource_type() -> String:
	return "Resource"


func _get_priority() -> float:
	return 1.0


func _get_import_order() -> int:
	return 0


func _get_preset_count() -> int:
	return 1


func _get_preset_name(_preset_index: int) -> String:
	return "Default"


func _get_import_options(_path: String, _preset_index: int) -> Array[Dictionary]:
	return []


func _get_option_visibility(_path: String, _option_name: StringName, _options: Dictionary) -> bool:
	return true


func _import(source_file: String, save_path: String, _options: Dictionary, _platform_variants: Array[String], _gen_files: Array[String]) -> Error:
	var animation := MoxelVolumeAnimation.load_file(source_file)
	if not animation:
		return ERR_PARSE_ERROR
	if animation.resource_name.is_empty():
		animation.resource_name = source_file.get_file().get_basename()
	return ResourceSaver.save(animation, "%s.%s" % [save_path, _get_save_extension()])
