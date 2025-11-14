# lcod://contract/core/path/to_file_url@1.0.0

Convert a filesystem path into a normalized `file://` URL (slashes normalized, `/./` segments collapsed, trailing slash enforced).

## Input (`schema/to_file_url.in.json`)
- `path` (string, optional): path to convert.

## Output (`schema/to_file_url.out.json`)
- `url` (string or null): normalized `file://` URL, or null when the input is empty.
