# Use one cancellation path

Run timeout, idle timeout, and consumer cancellation will use the same cleanup path: request ACP session cancellation, wait for a configurable grace period that defaults to five seconds, and terminate the adapter process only if it remains active. Results retain the initiating reason as `timeout`, `idle_timeout`, or `cancelled`, while resource release remains consistent.
