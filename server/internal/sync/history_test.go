// 文件历史（v0.11.24）的端到端用例：真的走 SQLite + ApplyPush，而不是 mock。
//
// 要钉死的不是 SQL 语法，是两条产品承诺：
//  1. 一条路径每 push 一次就多一版，**旧版内容还能按 hash 取回**；
//  2. 删掉的文件出现在「云端已删除」清单里，而且带的是删除**之前**最后一版的 blob。
package sync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"

	"github.com/ivyea/ivyea-note/server/internal/store"
)

func newStore(t *testing.T) *store.SQLiteStore {
	t.Helper()
	ctx := context.Background()
	st, err := store.ConnectSQLite(ctx, t.TempDir()+"/t.db")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	return st
}

func hashOf(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

var seq int

// push 一条变更；upsert 会先把内容当 blob 存进去。
// client_change_id 必须每次都新：同一个 id 重发是幂等返回，不会产生新版本
func push(t *testing.T, st store.Store, vaultID, userID int64, device, path, op, content string, base int64) PushResult {
	t.Helper()
	ctx := context.Background()
	seq++
	ch := PushChange{ClientChangeID: fmt.Sprintf("%s-%d", device, seq), Path: path, Op: op, BaseVersion: base}
	if op == "upsert" {
		h := hashOf([]byte(content))
		if err := st.PutBlob(ctx, h, userID, []byte(content)); err != nil {
			t.Fatal(err)
		}
		ch.BlobHash = &h
	}
	tx, err := st.BeginTx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	r, err := ApplyPush(ctx, tx, vaultID, userID, device, ch)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if r.Status != "accepted" {
		t.Fatalf("push %s %s 应 accepted，得到 %+v", op, path, r)
	}
	return r
}

func TestHistory_每一版都还拿得回来(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	uid, _ := st.CreateUser(ctx, "a@b.c", "x")
	_ = st.CreateDevice(ctx, "dA", uid)
	vid, _ := st.CreateVault(ctx, uid, "v")

	push(t, st, vid, uid, "dA", "a.md", "upsert", "第一版", 0)
	push(t, st, vid, uid, "dA", "a.md", "upsert", "第二版", 1)
	push(t, st, vid, uid, "dA", "a.md", "upsert", "第三版（误改）", 2)

	hist, err := st.History(ctx, vid, "a.md", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(hist) != 3 {
		t.Fatalf("想要 3 版，得到 %d", len(hist))
	}
	if hist[0].Version != 3 || hist[2].Version != 1 {
		t.Fatalf("应新的在前：%+v", hist)
	}
	// 旧版内容按 hash 取回——这就是"误改能找回"的全部依据
	got, err := st.GetBlob(ctx, *hist[1].BlobHash, uid)
	if err != nil || string(got) != "第二版" {
		t.Fatalf("第二版内容应还在，得到 %q err=%v", got, err)
	}
	if hist[1].Size != int64(len("第二版")) {
		t.Fatalf("size 应是 blob 长度，得到 %d", hist[1].Size)
	}
	if hist[0].DeviceID != "dA" {
		t.Fatalf("应记录改动来自哪台设备：%+v", hist[0])
	}
	// 别的路径一条都不该混进来
	other, _ := st.History(ctx, vid, "b.md", 50)
	if len(other) != 0 {
		t.Fatalf("b.md 没有历史，得到 %d", len(other))
	}
}

func TestDeletedFiles_带删除前最后一版(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	uid, _ := st.CreateUser(ctx, "a@b.c", "x")
	_ = st.CreateDevice(ctx, "dA", uid)
	_ = st.CreateDevice(ctx, "dB", uid)
	vid, _ := st.CreateVault(ctx, uid, "v")

	push(t, st, vid, uid, "dA", "x.md", "upsert", "x1", 0)
	push(t, st, vid, uid, "dA", "x.md", "upsert", "x2", 1)
	push(t, st, vid, uid, "dB", "x.md", "delete", "", 2) // 手机上误删
	push(t, st, vid, uid, "dA", "keep.md", "upsert", "留着", 0)

	files, err := st.DeletedFiles(ctx, vid)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].Path != "x.md" {
		t.Fatalf("只有 x.md 被删了，得到 %+v", files)
	}
	f := files[0]
	if f.Version != 3 {
		t.Fatalf("墓碑版本应是 3，得到 %d", f.Version)
	}
	if f.BlobHash == nil || *f.BlobHash != hashOf([]byte("x2")) {
		t.Fatalf("应指向删除前最后一版 x2，得到 %v", f.BlobHash)
	}
	if f.DeletedAt.IsZero() {
		t.Fatalf("删除时间应有值")
	}

	// 恢复 = 以墓碑版本为 base 重新 upsert，之后它就不在清单里了
	push(t, st, vid, uid, "dA", "x.md", "upsert", "x2", 3)
	files, _ = st.DeletedFiles(ctx, vid)
	if len(files) != 0 {
		t.Fatalf("恢复后不该再列为已删除：%+v", files)
	}
	hist, _ := st.History(ctx, vid, "x.md", 50)
	if len(hist) != 4 || hist[1].Op != "delete" {
		t.Fatalf("历史里应能看到那次删除：%+v", hist)
	}
}
