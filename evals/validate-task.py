#!/usr/bin/env python3
"""Validate that an eval task actually discriminates.

A task only earns its place if the primary check and every fail_to_pass command
FAIL on the untouched fixture, every pass_to_pass guard PASSES on it, and both
pass once a genuinely correct fix is applied. Getting this wrong produces a task
that either always passes (measuring nothing) or can never pass.

Usage:
    python3 evals/validate-task.py evals/tasks/<name> [reference.mjs:target.mjs ...]

Each reference argument copies a known-good implementation over the fixture file
it names, so the "with reference fix" section proves the task is solvable and
that no guard contradicts a correct answer.
"""
import json, subprocess, sys, os

task_dir = sys.argv[1]
refs = sys.argv[2:]
cfg = json.load(open(os.path.join(task_dir, "task.json")))
work = "/tmp/kulmi-validate-" + os.path.basename(task_dir.rstrip("/"))
subprocess.run(["rm", "-rf", work], check=True)
subprocess.run(["cp", "-r", os.path.join(task_dir, "fixture"), work], check=True)


def run(cmd):
    return subprocess.run(cmd, shell=True, cwd=work, capture_output=True, text=True).returncode


print("== untouched fixture")
code = run(cfg["verify"])
print(f"  verify -> exit {code} {'OK (fails as required)' if code != 0 else 'PROBLEM: already passes'}")
for cmd in cfg.get("fail_to_pass", []):
    code = run(cmd)
    print(f"  fail_to_pass -> exit {code} {'OK' if code != 0 else 'PROBLEM: already passes'}")
for i, cmd in enumerate(cfg.get("pass_to_pass", [])):
    code = run(cmd)
    print(f"  guard[{i}] -> exit {code} {'OK' if code == 0 else 'PROBLEM: guard fails on fixture'}")

if refs:
    print("== with reference fix")
    for ref in refs:
        src, _, dest = ref.partition(":")
        subprocess.run(["cp", src, os.path.join(work, dest)], check=True)
    code = run(cfg["verify"])
    print(f"  verify -> exit {code} {'OK' if code == 0 else 'PROBLEM: reference fix does not pass'}")
    for i, cmd in enumerate(cfg.get("pass_to_pass", [])):
        code = run(cmd)
        print(f"  guard[{i}] -> exit {code} {'OK' if code == 0 else 'PROBLEM: guard fails after fix'}")
