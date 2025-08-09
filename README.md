
## Create a Heap Snapshot
```sh
curl -X POST http://localhost:3000/heap-snapshot -H "x-admin-key: YOUR_ADMIN_KEY"
```



## List Heap Snapshots
```
curl -X GET http://localhost:3000/heap-snapshot/list -H "x-admin-key: my-admin-key
```

## Download a Heap Snapshot
```sh
curl -v -H "x-admin-key: YOUR_ADMIN_KEY" -o snapshot.heapsnapshot -X GET "http://localhost:3000/heap-snapshot/download/heap-snapshot-2025-08-09T13-45-23-456Z.heapsnapshot"

```
