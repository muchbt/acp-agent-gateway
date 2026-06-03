# Distinguish Run References from durable Session References

The existing `v1` Stateless Run result uses the field name `sessionRef` as an in-process correlation identifier, but Phase 3 introduces persisted Session References that can be recovered across Gateway processes. Stateless runs will not be persisted or accepted for recovery. To avoid silently changing the meaning of an existing `v1` field, the gateway documents it as a legacy Run Reference and reserves an explicit `runRef` versus `sessionRef` split for a future contract revision.
