
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { AppState, SimulationVoxel, RebuildTarget, VoxelData } from '../types';
import { CONFIG, COLORS } from '../utils/voxelConstants';

/**
 * VoxelEngine (体素物理与渲染引擎)
 * ------------------------------
 * 这是一个封装了 Three.js 复杂逻辑的类。
 * 
 * 核心技术原理：
 * 1. **InstancedMesh (实例化网格)**：
 *    这是性能优化的关键。如果场景中有 1000 个方块，普通的 Three.js 写法是创建 1000 个 Mesh 对象，
 *    这会导致 1000 次 Draw Call (CPU 通知 GPU 绘图)，极大地消耗 CPU 性能。
 *    InstancedMesh 允许我们只定义 1 个几何体，然后一次性告诉 GPU："画 1000 次，每次的位置/颜色是这些..."。
 *    这使得 Draw Call 降为 1 次，即使在低端设备上也能流畅运行 60FPS。
 * 
 * 2. **物理模拟循环 (Physics Loop)**：
 *    在 `updatePhysics` 中，手动计算每个方块的位置、速度和加速度（模拟重力）。
 *    我们不使用重型物理引擎（如 Cannon.js），而是手写简单的欧拉积分，因为我们只需要简单的掉落和反弹效果。
 * 
 * 3. **贪婪匹配算法 (Greedy Algorithm for Rebuild)**：
 *    在重组阶段，需要决定"地上的哪个旧方块"应该飞去"空中的哪个新位置"。
 *    我们遍历每个目标位置，在当前散落的方块中寻找"颜色最接近"且"未被占用"的方块。
 */
export class VoxelEngine {
  private container: HTMLElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  
  // InstancedMesh 实例，负责渲染所有方块
  private instanceMesh: THREE.InstancedMesh | null = null;
  // Dummy 对象：一个空的 3D 对象，用于辅助计算矩阵。避免在循环中频繁 `new Matrix4()` 造成垃圾回收压力。
  private dummy = new THREE.Object3D();
  
  // 核心数据源：存储场景中每个方块的实时状态 (位置 x/y/z, 速度 vx/vy/vz, 颜色)
  private voxels: SimulationVoxel[] = [];
  
  // 重组目标：当点击 Rebuild 时，这里存储每个方块的"终点"和"出发时间"
  private rebuildTargets: RebuildTarget[] = [];
  private rebuildStartTime: number = 0;
  
  private state: AppState = AppState.STABLE;
  private onStateChange: (state: AppState) => void; // 回调：通知 React 状态变了
  private onCountChange: (count: number) => void;   // 回调：通知 React 方块数变了
  private animationId: number = 0;

  constructor(
    container: HTMLElement, 
    onStateChange: (state: AppState) => void,
    onCountChange: (count: number) => void
  ) {
    this.container = container;
    this.onStateChange = onStateChange;
    this.onCountChange = onCountChange;

    // --- 1. 初始化 Three.js 场景 ---
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(CONFIG.BG_COLOR);
    // 雾效：让远处的物体淡入背景，增加深度感和柔和感
    this.scene.fog = new THREE.Fog(CONFIG.BG_COLOR, 60, 140); 

    // --- 2. 初始化相机 ---
    // FOV 45 度，模拟人眼的舒适视角
    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(30, 30, 60); // 初始位置

    // --- 3. 初始化渲染器 ---
    this.renderer = new THREE.WebGLRenderer({ antialias: true }); // 开启抗锯齿
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true; // 开启阴影计算
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap; // 使用软阴影，边缘更柔和
    container.appendChild(this.renderer.domElement);

    // --- 4. 交互控制器 ---
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; // 阻尼感：鼠标松开后还会滑行一段，手感更佳
    this.controls.autoRotate = true;    // 自动旋转展示
    this.controls.autoRotateSpeed = 0.5;
    this.controls.target.set(0, 5, 0);  // 旋转中心点设置在模型中心偏上

    // --- 5. 灯光系统 ---
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7); // 环境光，照亮暗部
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5); // 主光源 (模拟太阳)
    dirLight.position.set(50, 80, 30);
    dirLight.castShadow = true;
    // 优化阴影性能：缩小阴影相机的视锥体范围，使其只覆盖模型区域，从而提高阴影贴图的分辨率
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.left = -40;
    dirLight.shadow.camera.right = 40;
    dirLight.shadow.camera.top = 40;
    dirLight.shadow.camera.bottom = -40;
    this.scene.add(dirLight);

    // --- 6. 地板 ---
    const planeMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 1 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), planeMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = CONFIG.FLOOR_Y;
    floor.receiveShadow = true; // 接收方块投下的阴影
    this.scene.add(floor);

    // 启动渲染循环
    this.animate = this.animate.bind(this);
    this.animate();
  }

  /**
   * 加载全新的模型数据
   * 过程：销毁旧的 InstancedMesh -> 根据新数据创建新的 InstancedMesh -> 重置状态
   */
  public loadInitialModel(data: VoxelData[]) {
    this.createVoxels(data);
    this.onCountChange(this.voxels.length);
    this.state = AppState.STABLE;
    this.onStateChange(this.state);
  }

  /**
   * 核心函数：创建 InstancedMesh
   */
  private createVoxels(data: VoxelData[]) {
    // 资源清理：防止显存泄漏
    if (this.instanceMesh) {
      this.scene.remove(this.instanceMesh);
      this.instanceMesh.geometry.dispose();
      if (Array.isArray(this.instanceMesh.material)) {
          this.instanceMesh.material.forEach(m => m.dispose());
      } else {
          this.instanceMesh.material.dispose();
      }
    }

    // 初始化 SimulationVoxel 数组
    // 这里将单纯的数据 (VoxelData) 转换为带有物理状态的对象
    this.voxels = data.map((v, i) => {
        const c = new THREE.Color(v.color);
        // 视觉优化：给颜色增加微小的随机扰动，让纯色区域看起来更有质感，不那么死板
        c.offsetHSL(0, 0, (Math.random() * 0.1) - 0.05);
        return {
            id: i,
            x: v.x, y: v.y, z: v.z, color: c,
            vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, // 速度与旋转归零
            rvx: 0, rvy: 0, rvz: 0
        };
    });

    // 创建共享的几何体
    // 尺寸略小于 1 (如 0.95)，是为了在方块堆叠时产生微小的缝隙，增强"积木"的视觉效果
    const geometry = new THREE.BoxGeometry(CONFIG.VOXEL_SIZE - 0.05, CONFIG.VOXEL_SIZE - 0.05, CONFIG.VOXEL_SIZE - 0.05);
    const material = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.1 });
    
    // 创建 InstancedMesh，数量为 data.length
    this.instanceMesh = new THREE.InstancedMesh(geometry, material, this.voxels.length);
    this.instanceMesh.castShadow = true;
    this.instanceMesh.receiveShadow = true;
    this.scene.add(this.instanceMesh);

    // 第一次绘制，将位置和颜色写入 GPU
    this.draw();
  }

  /**
   * 渲染同步：将 CPU 中的 voxels 状态同步到 GPU 的 InstancedMesh 中
   */
  private draw() {
    if (!this.instanceMesh) return;
    this.voxels.forEach((v, i) => {
        // 设置位置和旋转
        this.dummy.position.set(v.x, v.y, v.z);
        this.dummy.rotation.set(v.rx, v.ry, v.rz);
        this.dummy.updateMatrix(); // 计算矩阵
        
        this.instanceMesh!.setMatrixAt(i, this.dummy.matrix); // 写入第 i 个实例的矩阵
        this.instanceMesh!.setColorAt(i, v.color);            // 写入第 i 个实例的颜色
    });
    // 必须手动标记更新，Three.js 才会将数据上传至 GPU
    this.instanceMesh.instanceMatrix.needsUpdate = true;
    this.instanceMesh.instanceColor!.needsUpdate = true;
  }

  /**
   * 拆解逻辑 (Dismantle)
   * 给所有方块施加随机的初始速度和角速度，使它们像受爆炸冲击一样散开
   */
  public dismantle() {
    if (this.state !== AppState.STABLE) return;
    this.state = AppState.DISMANTLING;
    this.onStateChange(this.state);

    this.voxels.forEach(v => {
        // 赋予随机初速度 (Explosion effect)
        v.vx = (Math.random() - 0.5) * 0.8;
        v.vy = Math.random() * 0.5;         // 稍微向上抛一点
        v.vz = (Math.random() - 0.5) * 0.8;
        // 赋予随机旋转速度
        v.rvx = (Math.random() - 0.5) * 0.2;
        v.rvy = (Math.random() - 0.5) * 0.2;
        v.rvz = (Math.random() - 0.5) * 0.2;
    });
  }

  // 辅助函数：计算两个颜色的感知距离 (视觉差异)
  private getColorDist(c1: THREE.Color, hex2: number): number {
    const c2 = new THREE.Color(hex2);
    // 加权欧几里得距离：人眼对绿色更敏感，所以 Green 通道权重更高
    const r = (c1.r - c2.r) * 0.3;
    const g = (c1.g - c2.g) * 0.59;
    const b = (c1.b - c2.b) * 0.11;
    return Math.sqrt(r * r + g * g + b * b);
  }

  /**
   * 重组逻辑 (Rebuild - 核心算法)
   * 目标：将地上散落的方块 (voxels) 移动到新模型 (targetModel) 的位置。
   * 难点：如何最优匹配？例如，如果你要拼一只绿色的青蛙，应该优先吸附地上绿色的方块，而不是红色的。
   */
  public rebuild(targetModel: VoxelData[]) {
    if (this.state === AppState.REBUILDING) return;

    // 1. 标记所有当前可用的方块
    const available = this.voxels.map((v, i) => ({ index: i, color: v.color, taken: false }));
    const mappings: RebuildTarget[] = new Array(this.voxels.length).fill(null);

    // 2. 贪婪算法匹配
    // 遍历新模型的每一个目标点 (target)
    targetModel.forEach(target => {
        let bestDist = 9999;
        let bestIdx = -1;

        // 在所有未被占用的方块中，寻找颜色最接近的一个
        for (let i = 0; i < available.length; i++) {
            if (available[i].taken) continue;

            // 计算颜色差异
            const d = this.getColorDist(available[i].color, target.color);
            
            // 启发式优化：如果是特殊的材质（如树叶），我们增加惩罚权重，
            // 防止它被分配给错误的部位，以此保留材质的逻辑一致性。
            const isLeafOrWood = (available[i].color.g > 0.4) || (available[i].color.r < 0.25 && available[i].color.b < 0.25);
            const targetIsGreen = target.color === COLORS.GREEN || target.color === COLORS.WOOD;
            const penalty = (isLeafOrWood && !targetIsGreen) ? 100 : 0;

            if (d + penalty < bestDist) {
                bestDist = d + penalty;
                bestIdx = i;
                if (d < 0.01) break; // 性能优化：如果找到颜色完全一样的，直接停止搜索，选中它
            }
        }

        // 3. 建立映射关系
        if (bestIdx !== -1) {
            available[bestIdx].taken = true;
            // delay: 根据目标高度 (y) 计算延迟。
            // 效果：方块会像盖房子一样，从下往上依次飞过去，而不是同时飞过去。
            const h = Math.max(0, (target.y - CONFIG.FLOOR_Y) / 15);
            mappings[available[bestIdx].index] = {
                x: target.x, y: target.y, z: target.z,
                delay: h * 800 // 高度越高，延迟越大
            };
        }
    });

    // 4. 处理多余方块
    // 如果新模型需要的方块少于旧模型，多出来的方块留在原地不动 (标记为 isRubble)
    for (let i = 0; i < this.voxels.length; i++) {
        if (!mappings[i]) {
            mappings[i] = {
                x: this.voxels[i].x, y: this.voxels[i].y, z: this.voxels[i].z,
                isRubble: true, delay: 0
            };
        }
    }

    this.rebuildTargets = mappings;
    this.rebuildStartTime = Date.now();
    this.state = AppState.REBUILDING;
    this.onStateChange(this.state);
  }

  /**
   * 物理与动画更新循环 (每帧调用)
   */
  private updatePhysics() {
    // 场景 A: 拆解中 (应用重力与碰撞)
    if (this.state === AppState.DISMANTLING) {
        this.voxels.forEach(v => {
            v.vy -= 0.025; // 简单的重力加速度
            v.x += v.vx; v.y += v.vy; v.z += v.vz; // 更新位置
            v.rx += v.rvx; v.ry += v.rvy; v.rz += v.rvz; // 更新旋转

            // 地板碰撞检测 (y < FLOOR_Y)
            if (v.y < CONFIG.FLOOR_Y + 0.5) {
                v.y = CONFIG.FLOOR_Y + 0.5; // 修正位置防止穿模
                // 速度反转并衰减 (模拟能量损失，0.5 是弹力系数)
                v.vy *= -0.5; 
                v.vx *= 0.9; v.vz *= 0.9; // 地面摩擦力
                v.rvx *= 0.8; v.rvy *= 0.8; v.rvz *= 0.8; // 旋转衰减
            }
        });
    } 
    // 场景 B: 重建中 (插值动画)
    else if (this.state === AppState.REBUILDING) {
        const now = Date.now();
        const elapsed = now - this.rebuildStartTime;
        let allDone = true;

        this.voxels.forEach((v, i) => {
            const t = this.rebuildTargets[i];
            if (t.isRubble) return; // 废墟不需要移动

            if (elapsed < t.delay) {
                allDone = false; // 时间还没到，暂不移动
                return;
            }

            // 线性插值 (Lerp)：每一帧移动剩余距离的 12%
            // 这会产生一种"先快后慢"的平滑磁吸效果
            const speed = 0.12;
            v.x += (t.x - v.x) * speed;
            v.y += (t.y - v.y) * speed;
            v.z += (t.z - v.z) * speed;
            
            // 旋转慢慢复位到 0 (对齐网格)
            v.rx += (0 - v.rx) * speed;
            v.ry += (0 - v.ry) * speed;
            v.rz += (0 - v.rz) * speed;

            // 检查是否到达目标 (距离平方 <阈值)
            if ((t.x - v.x) ** 2 + (t.y - v.y) ** 2 + (t.z - v.z) ** 2 > 0.01) {
                allDone = false;
            } else {
                // 强制吸附到整数网格，消除微小的抖动
                v.x = t.x; v.y = t.y; v.z = t.z;
                v.rx = 0; v.ry = 0; v.rz = 0;
            }
        });

        if (allDone) {
            this.state = AppState.STABLE;
            this.onStateChange(this.state);
        }
    }
  }

  // 主渲染循环 (requestAnimationFrame)
  private animate() {
    this.animationId = requestAnimationFrame(this.animate);
    this.controls.update(); // 更新相机轨道控制器
    this.updatePhysics();   // 更新物理位置
    
    // 性能优化：只有在物体移动 (非 STABLE) 或者相机自动旋转时，才需要更新 InstancedMesh
    // 在静止状态下，我们可以停止向 GPU 发送数据，节省资源
    if (this.state !== AppState.STABLE || this.controls.autoRotate) {
        this.draw();
    }
    
    this.renderer.render(this.scene, this.camera);
  }

  public handleResize() {
      if (this.camera && this.renderer) {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
      }
  }
  
  public setAutoRotate(enabled: boolean) {
    if (this.controls) {
        this.controls.autoRotate = enabled;
    }
  }

  public getJsonData(): string {
      const data = this.voxels.map((v, i) => ({
          id: i,
          x: +v.x.toFixed(2),
          y: +v.y.toFixed(2),
          z: +v.z.toFixed(2),
          c: '#' + v.color.getHexString()
      }));
      return JSON.stringify(data, null, 2);
  }
  
  public getUniqueColors(): string[] {
    const colors = new Set<string>();
    this.voxels.forEach(v => {
        colors.add('#' + v.color.getHexString());
    });
    return Array.from(colors);
  }

  public cleanup() {
    cancelAnimationFrame(this.animationId);
    this.container.removeChild(this.renderer.domElement);
    this.renderer.dispose();
  }
}
