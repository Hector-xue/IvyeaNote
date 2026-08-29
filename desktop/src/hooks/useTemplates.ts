/**
 * 日记与模板（从 App.tsx 抽出，v0.8.0 P1.4）。
 *
 * 两条路径都是「按规则算出一个路径 → 不存在就用模板生成 → 打开」，原来却各写各的，
 * 连 `renderTemplateSafe` 这个包装都是挂在组件体里的普通函数（每次渲染重建一个）。
 *
 * hook 只依赖 `files` 列表和 IO，不认识 vault 对象本身。
 */
import { useCallback } from 'react';
import type { FileIO } from '../lib/sync';
import { todayPath, dailyContent, templateFiles, renderTemplate } from '../lib/daily';
import { titleOfPath } from '../lib/wikilink';

/** 新建模板目录时给的示例，避免用户面对一个空 Templates/ 不知道写什么 */
export const SAMPLE_TEMPLATE_PATH = 'Templates/会议.md';
export const SAMPLE_TEMPLATE_BODY =
  '# {{title}}\n\n- 时间：{{date}} {{time}}\n- 参会：\n\n## 议题\n\n## 结论\n';

/** 渲染模板：{{title}} 用的是文件名（去目录、去 .md 后缀） */
export function renderTemplateFor(tpl: string, path: string): string {
  const base = path.replace(/\.md$/i, '').split('/').pop() ?? path;
  return renderTemplate(tpl, base);
}

/** 用户输入的名字 → 库内相对路径（补 .md、去掉结尾的斜杠） */
export function templateNoteRel(input: string): string {
  const clean = input.trim().replace(/\/+$/, '');
  return clean.endsWith('.md') ? clean : `${clean}.md`;
}

export interface TemplatesDeps {
  vaultPath: string | null;
  io: FileIO;
  /** 当前库的全部文件路径，用来找 Templates/ 下有什么 */
  files: string[];
  refreshFiles(): Promise<void>;
  openInTab(path: string): void;
  doSync(): void;
  prompt(opts: {
    title: string;
    description?: string;
    placeholder?: string;
    okText?: string;
    validate?(v: string): string | null;
  }): Promise<string | null>;
  toast(msg: string, kind: 'ok' | 'error'): void;
  errText(e: unknown): string;
}

export interface Templates {
  /** 打开今日日记；不存在就按 Templates/日记.md（若有）或默认骨架创建 */
  openDaily(): Promise<void>;
  /** 从模板新建笔记；一个模板都没有时先建示例模板 */
  newFromTemplate(): Promise<void>;
}

export function useTemplates(deps: TemplatesDeps): Templates {
  const { vaultPath, io, files, refreshFiles, openInTab, doSync, prompt, toast, errText } = deps;
  const root = vaultPath ?? '';

  const openDaily = useCallback(async () => {
    if (vaultPath === null) return;
    const path = todayPath();
    try {
      if (await io.exists(root, path)) {
        openInTab(path);
        return;
      }
      // 有 Templates/日记.md 就套用，否则用默认骨架
      let content = dailyContent();
      if (templateFiles(files).some((f) => titleOfPath(f) === '日记')) {
        try {
          content = renderTemplateFor(await io.read(root, 'Templates/日记.md'), path);
        } catch {
          /* 模板读取失败：用默认骨架，不该因为模板坏了就打不开日记 */
        }
      }
      await io.write(root, path, content);
      await refreshFiles();
      openInTab(path);
      doSync();
    } catch (e) {
      toast(`打开日记失败：${errText(e)}`, 'error');
    }
  }, [vaultPath, root, io, files, refreshFiles, openInTab, doSync, toast, errText]);

  const newFromTemplate = useCallback(async () => {
    if (vaultPath === null) return;
    const tpls = templateFiles(files);
    if (tpls.length === 0) {
      // 首次使用：建模板目录 + 示例模板
      await io.write(root, SAMPLE_TEMPLATE_PATH, SAMPLE_TEMPLATE_BODY);
      await refreshFiles();
      toast(`已创建 ${SAMPLE_TEMPLATE_PATH} 示例模板，编辑后即可使用`, 'ok');
      doSync();
      return;
    }
    const name = await prompt({
      title: '从模板新建',
      description: `可用模板：${tpls.map((t) => titleOfPath(t)).join('、')}。输入新笔记名（可含目录）`,
      placeholder: '例：会议/产品周会',
      okText: '创建',
      validate: (v) => (v.trim() ? null : '请输入名称'),
    });
    if (!name) return;
    const rel = templateNoteRel(name);
    try {
      const tplPath = tpls.find((t) => titleOfPath(t) === titleOfPath(rel)) ?? tpls[0];
      const content = renderTemplateFor(await io.read(root, tplPath), rel);
      await io.write(root, rel, content);
      await refreshFiles();
      openInTab(rel);
      doSync();
    } catch (e) {
      toast(`创建失败：${errText(e)}`, 'error');
    }
  }, [vaultPath, root, io, files, refreshFiles, openInTab, doSync, prompt, toast, errText]);

  return { openDaily, newFromTemplate };
}
