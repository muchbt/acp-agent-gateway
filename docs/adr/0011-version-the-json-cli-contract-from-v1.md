# Version the JSON CLI contract from v1

Every JSON CLI request, successful result, and error result will include `apiVersion`. The first contract version is `v1`. Stable machine-readable error codes are part of this contract, including `invalid_request`, `adapter_not_found`, `sandbox_unavailable`, `timeout`, `idle_timeout`, `cancelled`, `protocol_error`, `unsupported_session_close`, and `unsupported_session_recovery`. This allows later session commands and fields to be added without forcing consumers to infer response shapes from package versions.
