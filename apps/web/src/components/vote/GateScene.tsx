import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { playGateMotion } from './gateMotion.js';

/**
 * 投票入口（Gate）的高铁主题入场场景：整列复兴号驶入并停在站台。
 *
 * 造型依据 CR400AF 量产车实车特征（维基百科「复兴号CR400AF型电力动车组」外觀一节）：
 *   - 涂装：银色底 + 黑色车窗带 + 车窗下方红色线条，先头车红线收成箭头形；
 *   - 8 辆编组（4M4T），车厢之间是压缩式风挡；
 *   - 转向架不完全覆盖、下部外露（但仍在车体轮廓内，不是独立小车）；
 *   - 车顶设受电弓。
 *
 * 为什么画长编组：高铁进站的真实观感是长编组减速停靠，单节车头更像地铁靠站。
 *
 * 几何约定（viewBox 0 0 W 200）：
 *   - 车顶 y=26，车身底沿 y=150，车轮底 y=170；
 *   - 受电弓只占用车顶上方 y≥2 的空间，不能越过 y=0，否则会被 viewBox 裁掉；
 *   - 车身高度是实车比例的约 2 倍（实车 3.7m/25m ≈ 15%，这里 124/400 ≈ 31%）——
 *     1:20 缩略下按真实比例会把车压成一条线，看不清结构，这是刻意放大；
 *   - 转向架收在车身底沿之下、车轮只露出下半圆，避免「一排小推车」。
 */

/**
 * CR400AF 8 辆编组（4M4T），实车构成见维基百科「复兴号CR400AF型电力动车组」：
 *   01 Tc（带驾驶室）｜02 M｜03 Tp（受电弓）｜04 M
 *   05 M（二等座/餐车）｜06 Tp（受电弓）｜07 M｜08 Tc（带驾驶室）
 * 两端车头本身就是 01 和 08 车，所以「8 节」= 2 个车头 + 6 节中间车厢。
 */
const CAR_COUNT = 6;
/** 单节车厢在 viewBox 里的宽度。 */
const CAR_WIDTH = 400;
/** 车头段宽度：够长才看得出流线鼻锥。 */
const HEAD_WIDTH = 460;
/** 画布总宽 = 前车头 + 6 节车厢 + 后车头，共 8 节。 */
const VIEW_WIDTH = HEAD_WIDTH * 2 + CAR_COUNT * CAR_WIDTH;
/**
 * 画布高度。8 节编组横向很长，若高度按单节比例走会被压成一条细线，
 * 因此把车身上下留白压到最小：车身 26→150（124 单位），画布 200，
 * 车身占画布 62%，编组变长不会把车压扁。
 */
const VIEW_HEIGHT = 200;

/**
 * 带受电弓的中间车厢序号：03、06 车是 Tp 拖车。
 * 中间车厢索引 0..5 对应整车 02..07 车，所以 03/06 车 = 索引 1/4。
 */
const PANTOGRAPH_CARS = [1, 4];

const CAR_TOP = 26;
const CAR_BOTTOM = 150;
const CAR_HEIGHT = CAR_BOTTOM - CAR_TOP;

/**
 * 单节车厢：车身、窗带、车窗、红线、裙板、两个转向架。
 *
 * 不画车门：这个场景是「进站停靠」的意象，车门细节在 1:20 的缩略侧视里
 * 只会变成一排小黑块，反而破坏车身完整性（实测如此）。
 */
function Car({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 0)`}>
      {/* 车身：银色底 */}
      <rect className="gate-body" x="0" y={CAR_TOP} width={CAR_WIDTH} height={CAR_HEIGHT} rx="5" />
      {/* 黑色车窗带 */}
      <rect className="gate-windowband" x="26" y="40" width={CAR_WIDTH - 52} height="42" rx="3" />
      {/* 车窗 */}
      {[44, 128, 212, 296].map((wx) => (
        <rect key={wx} className="gate-light" x={wx} y="46" width="56" height="30" rx="2" />
      ))}
      {/* 车窗下方红色线条 */}
      <rect className="gate-belt" x="26" y="94" width={CAR_WIDTH - 52} height="7" rx="1" />
      {/* 裙板：转向架不完全覆盖，下缘留出深色底架 */}
      <rect className="gate-skirt" x="0" y={CAR_BOTTOM - 16} width={CAR_WIDTH} height="16" />
      {/* 两个转向架：构架在车体下，车轮只露下半圆 */}
      {[100, 300].map((cx) => (
        <g key={cx} className="gate-bogie">
          <rect x={cx - 54} y={CAR_BOTTOM - 2} width="108" height="16" rx="3" />
          <circle cx={cx - 30} cy={CAR_BOTTOM + 12} r="12" />
          <circle cx={cx + 30} cy={CAR_BOTTOM + 12} r="12" />
        </g>
      ))}
    </g>
  );
}

/**
 * 车头：建模约定是「平直端在 x=0，鼻锥收在 x≈HEAD_WIDTH」。
 *
 * 连接规则：平直端必须贴着相邻车厢，鼻锥朝车外。
 *   - 前车头：平直端贴第一节车厢，所以整组镜像 → 鼻锥朝左（车外/行进方向）
 *   - 尾车头：平直端贴最后一节车厢，不镜像 → 鼻锥朝右（车外）
 * 两者都用 translate 定位到「平直端所在的位置」。
 *
 * `noseLeft` 为 true 时镜像，鼻锥朝左。
 */
function Head({ x, noseLeft }: { x: number; noseLeft: boolean }) {
  // 镜像后平直端落在 x + HEAD_WIDTH，因此平移量要补上宽度，保证 [x, x+HEAD_WIDTH] 不越界
  const transform = noseLeft
    ? `translate(${x + HEAD_WIDTH} 0) scale(-1 1)`
    : `translate(${x} 0)`;
  return (
    <g transform={transform}>
      {/* 车身：右侧收成流线鼻锥（镜像后朝左） */}
      <path
        className="gate-body"
        d={`M0 ${CAR_TOP} L ${HEAD_WIDTH - 300} ${CAR_TOP}
            C ${HEAD_WIDTH - 200} ${CAR_TOP}, ${HEAD_WIDTH - 120} 60, ${HEAD_WIDTH - 60} 92
            C ${HEAD_WIDTH - 24} 112, ${HEAD_WIDTH - 8} 132, ${HEAD_WIDTH - 6} 150
            L 0 ${CAR_BOTTOM} Z`}
      />
      {/* 驾驶室侧窗 */}
      <rect className="gate-windowband" x="24" y="40" width="200" height="42" rx="3" />
      <rect className="gate-light" x="40" y="46" width="80" height="30" rx="2" />
      <rect className="gate-light" x="132" y="46" width="76" height="30" rx="2" />
      {/* 箭头形红线：向后收拢，呼应先头车侧面的箭头设计 */}
      <path
        className="gate-belt"
        d={`M24 94 L 230 94 L ${HEAD_WIDTH - 92} 100 L 230 107 L 24 101 Z`}
      />
      {/* 裙板 */}
      <rect className="gate-skirt" x="0" y={CAR_BOTTOM - 16} width="240" height="16" />
      {/* 排障器：车头下方斜切的深色板 */}
      <path
        className="gate-skirt"
        d={`M240 ${CAR_BOTTOM - 16} L ${HEAD_WIDTH - 30} ${CAR_BOTTOM - 16} L ${HEAD_WIDTH - 46} ${CAR_BOTTOM + 12} L 240 ${CAR_BOTTOM + 12} Z`}
      />
      {/* 转向架 */}
      <g className="gate-bogie">
        <rect x="52" y={CAR_BOTTOM - 2} width="108" height="16" rx="3" />
        <circle cx="82" cy={CAR_BOTTOM + 12} r="12" />
        <circle cx="142" cy={CAR_BOTTOM + 12} r="12" />
      </g>
      {/* 车头灯：鼻锥前缘 */}
      <circle className="gate-headlight" cx={HEAD_WIDTH - 30} cy="118" r="6" />
    </g>
  );
}

/**
 * 受电弓：装在 03、06 车顶部，升弓状态。
 *
 * 全部 y 坐标必须 ≥ 0：viewBox 从 y=0 起，负值会被 SVG 根元素裁掉。
 * 车顶在 y=26，可用高度只有 24 单位，因此把弓臂压成 18 高、弓头贴到 y=2——
 * 之前弓头写在 y=-28，整根弓头压根没画出来。
 */
function Pantograph({ x }: { x: number }) {
  return (
    <g className="gate-pantograph" transform={`translate(${x} 0)`}>
      {/* 绝缘子底座：搭在车顶线上 */}
      <rect x="0" y={CAR_TOP - 6} width="92" height="6" rx="2" />
      {/* 下臂与上臂：左右对称，顶点落在 y=8 */}
      <path d="M18 20 L 46 8 L 74 20" />
      {/* 受电弓头：贴住接触网 */}
      <rect className="gate-pantograph-bar" x="26" y="2" width="40" height="5" rx="2" />
    </g>
  );
}

/**
 * 高铁入场场景壳：列车驶入停稳后，才把卡片内容交给 React 渲染。
 *
 * 内容不参与补间：动画播完前它根本不在 DOM 里，所以不存在「淡入到一半
 * 被打断」或「卡片先闪一下再动」的问题。reduced-motion 下没有补间，
 * gateMotion 会立即回调，内容照常出现（无障碍基线不退化）。
 */
export function GateScene({ withTrain, children }: { withTrain: boolean; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  // 没有列车时（正常投票页）内容立即可见，不需要等待
  const [settled, setSettled] = useState(!withTrain);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return undefined;
    setSettled(!withTrain);
    return playGateMotion({ root, withTrain, onSettled: () => setSettled(true) });
  }, [withTrain]);

  return (
    <div ref={rootRef} className="gate-scene" aria-busy={withTrain && !settled}>
      {/* 动画期间内容不在 DOM 里，读屏不会误读半成品 */}
      <div className="gate-content">{settled ? children : null}</div>
      {withTrain ? (
        <div className="gate-stage" aria-hidden="true">
          <div className="gate-platform" />
          <div className="gate-track" />
          <div className="gate-train">
            {/*
              aria-hidden 已在父级声明，子树不必重复 role="presentation"；
              width:100% + height:auto 下 preserveAspectRatio 也不会生效，故不写。
            */}
            <svg
              className="gate-train-body"
              viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
              focusable="false"
            >
              {/* 前车头：占 [0, HEAD_WIDTH]，平直端贴第一节车厢，鼻锥朝左（车外/行进方向） */}
              <Head x={0} noseLeft />
              {Array.from({ length: CAR_COUNT }, (_, i) => (
                <Car key={i} x={HEAD_WIDTH + i * CAR_WIDTH} />
              ))}
              {/* 尾车头：平直端贴最后一节车厢，鼻锥朝右（车外） */}
              <Head x={HEAD_WIDTH + CAR_COUNT * CAR_WIDTH} noseLeft={false} />
              {/* 受电弓：装在 03、06 车（Tp 拖车）顶部 */}
              {PANTOGRAPH_CARS.map((i) => (
                <Pantograph key={i} x={HEAD_WIDTH + i * CAR_WIDTH + 150} />
              ))}
            </svg>
          </div>
        </div>
      ) : null}
    </div>
  );
}
