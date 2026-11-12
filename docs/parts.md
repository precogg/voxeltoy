# Rigged parts

Replaced. Layers no longer have parents and pivots: a model has markers and an
origin, and a rigged character is a scene of part models, each attached to a
mount marker on its parent part. See [pipeline.md](pipeline.md).

Older files open with each layer's pivot as a mount marker named after the
layer; layer parents are dropped.
