## Test-only: a plain mesh of a pose's voxels, one quad per exposed face with the palette color,
## to compare the ray-marched volume against. Not greedy; not part of the addon.
extends RefCounted


static func build(vols: MoxelVolumeAnimation, pose: int) -> ArrayMesh:
	var s: Vector3i = vols.pose_sizes[pose]
	var o := Vector3(vols.pose_offsets[pose])
	var data: PackedByteArray = vols.pose_data[pose]
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var solid := func(x: int, y: int, z: int) -> bool:
		return x >= 0 and y >= 0 and z >= 0 and x < s.x and y < s.y and z < s.z and data[x + s.x * (y + s.y * z)] != 0
	# Each face: its normal, and its four corners counterclockwise seen from outside.
	var faces := [
		[Vector3(-1, 0, 0), [Vector3(0, 0, 0), Vector3(0, 0, 1), Vector3(0, 1, 1), Vector3(0, 1, 0)]],
		[Vector3(1, 0, 0), [Vector3(1, 0, 1), Vector3(1, 0, 0), Vector3(1, 1, 0), Vector3(1, 1, 1)]],
		[Vector3(0, -1, 0), [Vector3(0, 0, 0), Vector3(1, 0, 0), Vector3(1, 0, 1), Vector3(0, 0, 1)]],
		[Vector3(0, 1, 0), [Vector3(0, 1, 1), Vector3(1, 1, 1), Vector3(1, 1, 0), Vector3(0, 1, 0)]],
		[Vector3(0, 0, -1), [Vector3(1, 0, 0), Vector3(0, 0, 0), Vector3(0, 1, 0), Vector3(1, 1, 0)]],
		[Vector3(0, 0, 1), [Vector3(0, 0, 1), Vector3(1, 0, 1), Vector3(1, 1, 1), Vector3(0, 1, 1)]],
	]
	for z in s.z:
		for y in s.y:
			for x in s.x:
				var value := data[x + s.x * (y + s.y * z)]
				if value == 0:
					continue
				var base := o + Vector3(x, y, z)
				for face in faces:
					var n: Vector3 = face[0]
					if solid.call(x + int(n.x), y + int(n.y), z + int(n.z)):
						continue
					var c: Array = face[1]
					st.set_normal(n)
					st.set_color(vols.colors[value])
					# Godot's front faces are clockwise, so emit each quad's corners reversed.
					for i in [0, 2, 1, 0, 3, 2]:
						st.add_vertex(base + c[i])
	return st.commit()
