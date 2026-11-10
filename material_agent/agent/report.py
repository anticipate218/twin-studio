"""报告生成：图文报告 REPORT.md + report.json，并把产物收拢到 final/。"""
import json
import os
import shutil


def _copy(src, dst_dir, name=None):
    if not src or not os.path.exists(src):
        return None
    dst = os.path.join(dst_dir, name or os.path.basename(src))
    try:
        shutil.copyfile(src, dst)
        return os.path.basename(dst)
    except Exception:
        return None


def _rel(path):
    return os.path.basename(path) if path else None


def write_final(run_dir, report, evidence, prompt, rounds):
    final_dir = os.path.join(run_dir, 'final')
    os.makedirs(final_dir, exist_ok=True)
    best = report.get('best')

    texture = None
    if best:
        texture = _copy(best['path'], final_dir, 'texture.png')
        score = best.get('score', 0)
        report['confidence'] = 'high' if score >= 4.3 else ('medium' if score >= 3.6 else 'low')
        report['final_image'] = os.path.join(final_dir, texture)

    ref_name = _copy(evidence.get('ref'), final_dir, 'reference.jpg')
    facade_info = evidence.get('facade') or {}
    facade_name = _copy(facade_info.get('path'), final_dir, 'facade.png')
    clean_name = _copy(report.get('clean_image'), final_dir, 'clean_view.png')

    # 机读文件随报告一起放 final/
    for fn in ('evidence.json',):
        _copy(os.path.join(run_dir, fn), final_dir, fn)
    _copy(os.path.join(run_dir, 'state.json'), final_dir, 'state.json')

    with open(os.path.join(run_dir, 'report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    _copy(os.path.join(run_dir, 'report.json'), final_dir, 'report.json')

    coord = report['coordinate']
    md = [f'# 材质结果 {report["run_id"]}', '']
    if texture:
        md += [f'![最终材质]({texture})', '']
    md += [f'- 坐标：WGS84 {coord["wgs84"][0]:.6f}, {coord["wgs84"][1]:.6f}'
           f'（GCJ02 {coord["gcj02"][0]:.6f}, {coord["gcj02"][1]:.6f}）',
           f'- 地址：{evidence["address"]["value"] or "-"}',
           f'- 轮次：{report["rounds_used"]}，耗时 {report["elapsed_s"]}s，置信度 {report.get("confidence")}',
           f'- 最终图：`{texture or "-"}`', '']

    if texture or ref_name or facade_name:
        md += ['## 结果图', '', '| 类型 | 预览 | 文件 |', '| --- | --- | --- |']
        if texture:
            md.append(f'| 最终材质 | ![{texture}]({texture}) | `{texture}` |')
        if ref_name:
            md.append(f'| 街景参考 | ![{ref_name}]({ref_name}) | `{ref_name}` |')
        if facade_name:
            md.append(f'| 校正立面 | ![{facade_name}]({facade_name}) | `{facade_name}` |')
        if clean_name:
            label = {'ok': '干净街景', 'low_fidelity': '干净街景（保真度低，仅示意）',
                     'not_passed': '干净街景（未通过自动评判）'}.get(report.get('clean_status'), '干净街景')
            md.append(f'| {label} | ![{clean_name}]({clean_name}) | `{clean_name}` |')
        md.append('')

    if best:
        c = best['critique']
        md += ['## 评分', '',
               f'- 总分 **{c["score"]}**（结构 {c["structure"]} / 材质 {c["material"]} / 颜色 {c["color"]}'
               f' / 质量 {c["quality"]} / 可平铺 {c["tileable"]}）',
               f'- 色差 ΔE（白平衡后）：{c.get("delta_e")}',
               f'- 接缝误差：{c.get("seam_error")}',
               f'- 评判投票：{c.get("votes")} 次，标准差 {c.get("score_std")}',
               f'- 问题：{"; ".join(c.get("issues") or []) or "无"}',
               f'- 建议：{c.get("suggestion") or "-"}', '',
               f'- 最佳候选：seed {best.get("seed")}，`{_rel(best.get("path"))}`', '']

    cb = report.get('clean_best')
    if cb:
        cc = cb.get('critique') or {}
        md += ['## 街景评判', '',
               f'- 总分 **{cc.get("score")}**（真实感 {cc.get("realism")} / 完整度 {cc.get("completeness")}'
               f' / 干净度 {cc.get("cleanliness")} / 主体聚焦 {cc.get("focus")} / 材质一致 {cc.get("material")}'
               f' / 原建筑保真 {cc.get("fidelity")}）',
               f'- 结构相似度 SSIM：{cc.get("ssim")}',
               f'- 状态：{report.get("clean_status")}',
               f'- 是否通过：{cc.get("pass")}',
               f'- 问题：{"; ".join(cc.get("issues") or []) or "无"}',
               f'- 建议：{cc.get("suggestion") or "-"}', '']
        logs = report.get('render_rounds_log') or []
        if logs:
            md += ['| 街景轮次 | seed | 分数 | 通过 | 问题 |', '| --- | --- | --- | --- | --- |']
            for rd in logs:
                for c2 in sorted(rd.get('candidates') or [], key=lambda x: x.get('score') or 0, reverse=True):
                    cr = c2.get('critique') or {}
                    md.append(f'| {rd.get("round")} | {c2.get("seed")} | {c2.get("score")} | {cr.get("pass")} | '
                              f'{"; ".join(cr.get("issues") or []) or "-"} |')
            md.append('')

    md += ['## 依据', '',
           '| 项 | 值 | 来源 |', '| --- | --- | --- |',
           f'| 坐标 | {coord["wgs84"][0]:.6f}, {coord["wgs84"][1]:.6f} | Mapillary/GPS 输入 |',
           f'| GCJ02 | {coord["gcj02"][0]:.6f}, {coord["gcj02"][1]:.6f} | 本地转换 |',
           f'| 地址 | {evidence["address"]["value"] or "-"} | {evidence["address"].get("source")} |']
    vision = evidence.get('vision') or {}
    if vision:
        md.append(f'| 视觉 | material={vision.get("material")}, color={vision.get("color")}, '
                  f'storeys={vision.get("storeys")}, lighting={vision.get("lighting")} | glm-4v-flash |')
    if facade_info:
        md.append(f'| 立面校正 | {facade_info.get("rectified")}，corners={facade_info.get("corners")} | facade.py |')
    md.append('')

    pois = evidence.get('pois') or []
    if pois:
        md += ['### 周边 POI', '', '| 名称 | 类别 | 距离(m) | 地址 |', '| --- | --- | --- | --- |']
        for p in pois[:8]:
            md.append(f'| {p.get("title")} | {p.get("category")} | {p.get("distance_m")} | {p.get("address") or ""} |')
        md.append('')

    sv = evidence.get('streetview') or []
    if sv:
        md += ['### 街景候选', '', '| id | 拍摄时间 | 朝向 | 质量 | 距离(m) |', '| --- | --- | --- | --- | --- |']
        for im in sv[:5]:
            md.append(f'| {im.get("id")} | {im.get("captured_at")} | {im.get("compass_angle")} | '
                      f'{im.get("quality_score")} | {im.get("distance_m") or im.get("_dist_m")} |')
        md.append('')

    md += ['## 提示词', '', f'```text\n{prompt}\n```', '']
    if report.get('clean_prompt'):
        md += ['## 干净街景提示词', '', f'```text\n{report["clean_prompt"]}\n```', '']

    md += ['## 工作记录', '']
    for rd in rounds or []:
        md += [f'### 第 {rd.get("round")} 轮', '']
        md += ['提示词：', '', f'```text\n{rd.get("prompt")}\n```', '']
        md += ['| seed | 总分 | 结构 | 材质 | 颜色 | 质量 | 平铺 | 通过 | 问题 |',
               '| --- | --- | --- | --- | --- | --- | --- | --- | --- |']
        cands = sorted(rd.get('candidates') or [], key=lambda x: x.get('score') or 0, reverse=True)
        for c in cands:
            md.append(f'| {c.get("seed")} | {c.get("score")} | {c.get("structure")} | {c.get("material")} | '
                      f'{c.get("color")} | {c.get("quality")} | {c.get("tileable")} | {c.get("pass")} | '
                      f'{"; ".join((c.get("critique") or {}).get("issues") or []) or "-"} |')
        md.append('')
        passed = any(c.get('pass') for c in cands)
        if passed:
            md += ['决策：通过，进入交付。', '']
        elif rd is (rounds or [])[-1]:
            md += ['决策：轮次用尽，取最高分候选并标记低置信。', '']
        else:
            md += ['决策：不达标，修改提示词进入下一轮。', '']

    files = [f for f in ('texture.png', 'reference.jpg', 'facade.png', 'clean_view.png', 'evidence.json', 'report.json', 'state.json')
             if os.path.exists(os.path.join(final_dir, f))]
    if files:
        md += ['## 交付文件', ''] + [f'- `{f}`' for f in files] + ['']

    with open(os.path.join(final_dir, 'REPORT.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(md))
    return final_dir
