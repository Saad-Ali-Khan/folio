import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {mock} from 'node:test';
import {connectOcrWorker,OCR_STARTUP_TIMEOUT_MS} from './ocr/server';

async function main(){
  mock.timers.enable({apis:['setTimeout']});
  const fixture=()=>{
    const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});
    const logs:string[]=[];let exits=0;
    const backend=connectOcrWorker(child as unknown as ChildProcessWithoutNullStreams,line=>logs.push(line),()=>{exits++;});
    const ready=()=>child.stdout.write(JSON.stringify({type:'ready',protocol:1,engine:'paddle-mobile',modelLoads:1})+'\n');
    return {child,backend,logs,ready,exits:()=>exits};
  };
  try{
    const slow=fixture();mock.timers.tick(95_000);
    assert.equal(slow.exits(),0,'a slow model load must survive the old 90-second cutoff');
    assert.equal(slow.backend.ready,false);
    slow.ready();assert.equal(slow.backend.ready,true);
    mock.timers.tick(OCR_STARTUP_TIMEOUT_MS);assert.equal(slow.exits(),0,'ready cancels the startup watchdog');
    slow.backend.stop();mock.timers.tick(OCR_STARTUP_TIMEOUT_MS);assert.equal(slow.exits(),0,'intentional shutdown cannot trigger a stale startup failure');

    const hung=fixture();mock.timers.tick(OCR_STARTUP_TIMEOUT_MS-1);assert.equal(hung.exits(),0);
    mock.timers.tick(1);assert.equal(hung.exits(),1);assert.equal(hung.backend.ready,false);
    assert(hung.logs.some(line=>line.includes('model startup timed out')));
    hung.ready();assert.equal(hung.backend.ready,false,'late readiness cannot revive a stopped worker');
    hung.child.emit('exit',1,null);assert.equal(hung.exits(),1,'fatal shutdown is reported once');

    const crashed=fixture();crashed.child.emit('exit',70,null);
    assert.equal(crashed.exits(),1);assert(crashed.logs.some(line=>line.includes('code=70')));
    mock.timers.tick(OCR_STARTUP_TIMEOUT_MS);assert.equal(crashed.exits(),1);

    const scan=fixture();scan.ready();
    const job=assert.rejects(scan.backend.call(Buffer.from('image'),'detect'),/OCR worker stopped/);
    mock.timers.tick(26_999);assert.equal(scan.exits(),0);
    mock.timers.tick(1);await job;assert.equal(scan.exits(),1);
    assert(scan.logs.some(line=>line.includes('inference timed out after 27000ms')));
    console.log('PASS slow startup beyond 90 seconds, bounded startup timeout, ready/stop timer cleanup, late-ready rejection, crash diagnostics and unchanged 27-second inference timeout. Simulated worker; no WSL, models or inventory.');
  }finally{mock.timers.reset();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
