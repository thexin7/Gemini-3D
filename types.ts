
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


import * as THREE from 'three';

// 应用程序的三种核心状态
export enum AppState {
  STABLE = 'STABLE',           // 稳定状态：模型展示中，物理静止
  DISMANTLING = 'DISMANTLING', // 拆解状态：方块受物理引擎控制，发生位移
  REBUILDING = 'REBUILDING'    // 重建状态：方块通过插值动画从当前位置飞向新目标
}

// 基础数据结构：仅包含位置和颜色 (用于 JSON 存储和网络传输)
export interface VoxelData {
  x: number;
  y: number;
  z: number;
  color: number; // 十六进制颜色值，如 0xFF0000
}

// 模拟数据结构：包含物理引擎所需的实时状态
// 每个 InstancedMesh 的实例都对应这样一个对象
export interface SimulationVoxel {
  id: number;
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  
  // 物理属性
  vx: number; // x 轴速度
  vy: number; // y 轴速度
  vz: number; // z 轴速度
  
  rx: number; // x 轴旋转角度
  ry: number; // y 轴旋转角度
  rz: number; // z 轴旋转角度
  
  rvx: number; // x 轴旋转速度
  rvy: number; // y 轴旋转速度
  rvz: number; // z 轴旋转速度
}

// 重建目标：定义了重组动画中，每个方块应该去哪里
export interface RebuildTarget {
  x: number;
  y: number;
  z: number;
  delay: number;    // 延迟时间 (ms)，用于制造从下往上堆叠的动画效果，避免所有方块同时飞行导致视觉混乱
  isRubble?: boolean; // 标记该方块是否是多余的 (即新模型方块数 < 旧模型方块数)，若是则变为废墟
}

// 保存的模型结构
export interface SavedModel {
  name: string;
  data: VoxelData[];
  baseModel?: string; // 如果是 Rebuild 产生的变体，记录它是基于哪个模型生成的 (Eagle -> Cat)
}
