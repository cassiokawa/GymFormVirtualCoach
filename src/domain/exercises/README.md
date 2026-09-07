# Exercise specs (data only)

Each exercise is a JSON document (`*.json`) in this directory. There is **no**
TypeScript here: exercise `id`s, names, and aliases live only in data. The
build scan (spec 02, task 13) fails the build if any exercise identifier
appears in a file matching `src/**/*.ts`.

The `ExerciseSpec` document contract and JSON loader arrive in task 2.
