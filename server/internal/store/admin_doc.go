// H8：Store 接口新增用户管理三方法（追加在 store.go 的 Store 接口之外，此处为接口定义补丁）。
// 为避免改动 store.go 大段，直接在接口里声明——见 store.go 的 Store 接口。
package store

import "context"

// 以下方法已加入 Store 接口（store.go）：
//   ListUsers(ctx) ([]User, error)
//   DeleteUser(ctx, userID int64) error   // 级联删除该用户全部数据
//   UserBlobBytes(ctx, userID int64) (int64, error)

var _ = context.Background
