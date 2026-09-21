/** 全链路桌面验收：真实 HTTP/SQLite/Skill Runtime，独立临时目录和固定模型。 */
import assert from "node:assert/strict";
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import path from "node:path";
import {pathToFileURL} from "node:url";

const root = path.resolve("..");
const runtime = process.env.AI_ME_PLAYWRIGHT_MODULE;
const {_electron} = await import(runtime ? pathToFileURL(runtime).href : "playwright");
await mkdir(path.join(root,"tmp"),{recursive:true});
await mkdir(path.join(root,"output/playwright"),{recursive:true});
const sandbox = await mkdtemp(path.join(root,"tmp/project-skills-"));
const first = path.join(sandbox,"root-a");
const second = path.join(sandbox,"root-b");
const skillRoot = path.join(first,".agents/skills/review");
await mkdir(skillRoot,{recursive:true});
await mkdir(second,{recursive:true});
await writeFile(path.join(skillRoot,"SKILL.md"),"---\nname: review\ndescription: Review code using REVIEW_PROBE checks\n---\nREVIEW_PROBE: 检查空值、幂等性和错误恢复。\n");
const port = await new Promise((resolve) => {const server=createServer();server.listen(0,"127.0.0.1",()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const base = `http://127.0.0.1:${port}`;
const backend = spawn(path.join(root,"backend/.venv/Scripts/python.exe"),["-m","uvicorn","workbench_acceptance_app:app","--app-dir",path.join(root,"backend/tests"),"--host","127.0.0.1","--port",String(port)],{cwd:path.join(root,"backend"),windowsHide:true,env:{...process.env,AI_ME_ACCEPTANCE_DIR:sandbox,AIME_SKILL_ROOTS:""}});
let serverLog = "";
backend.stderr.on("data",(data)=>{serverLog+=data;});
backend.stdout.on("data",()=>{});
let electron;
async function api(url, options) {const response=await fetch(base+url,options);assert.ok(response.ok,`${url}: ${response.status}`);return response.status===204?null:response.json();}
async function until(check) {for(let i=0;i<120;i++){if(await check()) return;await new Promise((resolve)=>setTimeout(resolve,250));}throw new Error("等待验收条件超时");}
try {
  await until(async()=>{try{return (await fetch(base+"/api/health")).ok;}catch{return false;}});
  electron = await _electron.launch({executablePath:path.resolve("node_modules/electron/dist/electron.exe"),args:[".",`--user-data-dir=${path.join(sandbox,"profile")}`],cwd:process.cwd(),env:{...process.env,AI_ME_API_URL:base}});
  const page = await electron.firstWindow();
  const errors=[];
  page.on("pageerror",(error)=>errors.push(error.message));
  await page.getByRole("button",{name:"选择工作区并进入"}).click();
  await page.getByLabel("项目名称",{exact:true}).fill("AI-ME 多根验收");
  await page.getByLabel("目录 1",{exact:true}).fill(first);
  await page.getByRole("button",{name:"添加目录",exact:true}).click();
  await page.getByLabel("目录 2",{exact:true}).fill(second);
  await page.getByRole("button",{name:"保存项目",exact:true}).click();
  await page.getByRole("button",{name:"选择项目",exact:true}).waitFor();
  assert.match(await page.getByRole("button",{name:"选择项目",exact:true}).innerText(),/AI-ME 多根验收/);
  let projects = await api("/api/projects");
  const project = projects[0];
  assert.equal(project.roots.length,2);
  await page.getByTestId("v4-composer-input").fill("$review");
  await page.getByRole("option",{name:/^review 工作区/}).click();
  await page.keyboard.type(" 执行一次技能验收");
  await page.getByTestId("v4-composer-send").click();
  await page.getByText("验收完成：已加载 REVIEW_PROBE 技能",{exact:true}).waitFor({timeout:30000});
  const original = (await api("/api/sessions"))[0];
  assert.equal(original.projectId,project.id);
  assert.deepEqual(original.workspaceRoots,project.roots.map((root)=>root.path));
  assert.equal((await api(`/api/sessions/${original.id}/usage`)).contextEstimated,true);
  await page.screenshot({path:path.join(root,"output/playwright/desktop-project-skill-session.png")});

  // 原版设置页：按项目作用域筛选，启停和固定都真实保存到独立 SQLite。
  await page.getByTestId("task-settings-button").click();
  await page.getByTestId("settings-section-nav-skill").click();
  await page.getByTestId("plugin-settings-scope-trigger").click();
  await page.getByRole("menuitemradio",{name:project.name,exact:true}).click();
  const toggle=page.getByRole("switch");
  await toggle.click();
  await until(async()=>!(await api(`/api/projects/${project.id}/skills`)).skills[0].enabled);
  await toggle.click();
  await until(async()=>(await api(`/api/projects/${project.id}/skills`)).skills[0].enabled);
  await page.getByRole("button",{name:"固定技能",exact:true}).click();
  await until(async()=>(await api(`/api/projects/${project.id}/skills`)).skills[0].pinned);
  await page.screenshot({path:path.join(root,"output/playwright/desktop-project-skills-settings.png")});
  await page.getByTestId("settings-back-button").click();

  // 修改名称及主目录：旧会话保留快照，新会话使用最新目录。
  await page.getByTestId("ai-me-preferences-trigger").click();
  await page.getByRole("menuitem",{name:"项目管理",exact:true}).click();
  await page.getByRole("button",{name:"编辑",exact:true}).click();
  await page.getByLabel("项目名称",{exact:true}).fill("AI-ME 已改名");
  await page.getByRole("button",{name:"设为主目录",exact:true}).click();
  await page.getByRole("button",{name:"保存项目",exact:true}).click();
  await page.getByRole("button",{name:"选择项目",exact:true}).waitFor();
  assert.match(await page.getByRole("button",{name:"选择项目",exact:true}).innerText(),/AI-ME 已改名/);
  assert.deepEqual((await api(`/api/sessions/${original.id}`)).workspaceRoots,original.workspaceRoots);
  await page.getByTestId("v4-composer-input").fill("核对新会话目录");
  await page.getByTestId("v4-composer-send").click();
  await until(async()=>(await api("/api/sessions")).length===2);
  const newer=(await api("/api/sessions")).find((s)=>s.id!==original.id);
  assert.equal(newer.projectId,project.id);
  assert.equal(newer.workspacePath,project.roots[1].path);
  await until(async()=>(await api(`/api/sessions/${newer.id}`)).activity==="idle");
  await page.getByTestId("ai-me-preferences-trigger").click();
  await page.getByRole("menuitem",{name:"项目管理",exact:true}).click();
  await page.screenshot({path:path.join(root,"output/playwright/desktop-project-manager.png")});
  await page.getByRole("button",{name:"删除",exact:true}).click();
  await page.getByRole("button",{name:"确认删除",exact:true}).click();
  await until(async()=>(await api("/api/projects")).length===0);
  await page.getByRole("button",{name:"取消",exact:true}).click();
  assert.equal((await api(`/api/sessions/${original.id}`)).projectId,null);
  assert.equal((await api("/api/sessions")).length,2);
  await page.reload();
  await page.getByTestId("ai-me-preferences-trigger").waitFor();
  assert.equal(await page.getByTestId("window-control-close").count(),1);
  assert.deepEqual(errors,[]);
  console.log("PASS: 多根项目/真实 Skill 引用/启停固定/改名/目录快照/新会话归属/删除解绑/重载/桌面窗控");
  console.log(`隔离验收数据: ${sandbox}`);
} catch (error) {console.error(serverLog);throw error;}
finally {await electron?.close();backend.kill();}
