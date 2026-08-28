# Excluded files

The `visual/` directory of the original analysis package is intentionally not
included in this repository. It contained rendered screenshots and HTML
summaries that duplicated results already available in machine-readable form,
and some of its figures were superseded during manuscript revision.

Every result reported in the manuscript is supported by the CSV files in
`3_raw_measurements/` and the execution logs in `6_provenance/raw/`.

Running `sha256sum -c checksums.sha256` will report the `visual/` entries as
missing. All other entries verify successfully. `checksums.sha256` and
`FILE_MANIFEST.csv` are unmodified and reflect the original analysis package.
