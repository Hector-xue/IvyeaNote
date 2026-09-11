// 库软删除（v0.11.25）：删掉之后列表不再有它、属主校验为 false（同步 403）、
// 已删除 id 单独列出来（客户端据此"放手"而不是"复活"）、内容原样留着。
package sync

import (
	"context"
	"testing"

	"github.com/ivyea/ivyea-note/server/internal/store"
)

func TestDeleteVault_软删除后不列出且不再拥有(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	uid, _ := st.CreateUser(ctx, "a@b.c", "x")
	_ = st.CreateDevice(ctx, "dA", uid)
	keep, _ := st.CreateVault(ctx, uid, "留着")
	gone, _ := st.CreateVault(ctx, uid, "测试用空库")
	push(t, st, gone, uid, "dA", "a.md", "upsert", "内容", 0)

	if err := st.DeleteVault(ctx, gone, uid); err != nil {
		t.Fatal(err)
	}
	// 再删一次：已经不在了
	if err := st.DeleteVault(ctx, gone, uid); err != store.ErrNoRows {
		t.Fatalf("重复删除应 ErrNoRows，得到 %v", err)
	}
	list, _ := st.ListVaults(ctx, uid)
	if len(list) != 1 || list[0].ID != keep {
		t.Fatalf("列表应只剩「留着」，得到 %+v", list)
	}
	if ok, _ := st.VaultOwnedBy(ctx, gone, uid); ok {
		t.Fatalf("删掉的库不该再算属主（同步必须 403）")
	}
	if ok, _ := st.VaultOwnedBy(ctx, keep, uid); !ok {
		t.Fatalf("没删的库照常")
	}
	deleted, _ := st.ListDeletedVaultIDs(ctx, uid)
	if len(deleted) != 1 || deleted[0] != gone {
		t.Fatalf("已删除清单应是 [%d]，得到 %v", gone, deleted)
	}
	// 内容还在：历史接口照样能翻
	hist, _ := st.History(ctx, gone, "a.md", 10)
	if len(hist) != 1 {
		t.Fatalf("软删除不该动内容，得到 %d 版", len(hist))
	}
	// 别人的库删不掉
	other, _ := st.CreateUser(ctx, "z@b.c", "x")
	if err := st.DeleteVault(ctx, keep, other); err != store.ErrNoRows {
		t.Fatalf("别人的库应 ErrNoRows，得到 %v", err)
	}
}

func TestRenameVault(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	uid, _ := st.CreateUser(ctx, "a@b.c", "x")
	id, _ := st.CreateVault(ctx, uid, "旧名")
	if err := st.RenameVault(ctx, id, uid, "我的笔记"); err != nil {
		t.Fatal(err)
	}
	list, _ := st.ListVaults(ctx, uid)
	if list[0].Name != "我的笔记" {
		t.Fatalf("改名没生效：%+v", list)
	}
}

// 老库升级：表已经存在、没有 deleted_at 列 → Migrate 第二次跑要能补上且幂等
func TestMigrate_幂等补列(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("第二次 Migrate 应幂等，得到 %v", err)
	}
	uid, _ := st.CreateUser(ctx, "a@b.c", "x")
	if _, err := st.ListDeletedVaultIDs(ctx, uid); err != nil {
		t.Fatal(err)
	}
}
