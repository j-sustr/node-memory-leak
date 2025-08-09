
## Create a Heap Snapshot
```sh
curl -X POST http://localhost:3000/heap-snapshot -H "x-admin-key: my-admin-key"
```



## List Heap Snapshots
```
curl -X GET http://localhost:3000/heap-snapshot/list -H "x-admin-key: my-admin-key"
```

## Download a Heap Snapshot
```sh
curl -v -H "x-admin-key: my-admin-key" -o snapshot.heapsnapshot -X GET "http://localhost:3000/heap-snapshot/download/heap-snapshot-2025-08-09T14-07-01-607Z.heapsnapshot"

```
