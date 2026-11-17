"""Checks for Practice by topic (tutor.py practice / practice_reply, the /api/tutor route). A plain script:

    python tests/test_practice.py

Runs on a copy of example-library in a temporary folder; the model is never called (run_model is replaced by a stub
that returns a fixed answer and records what it was asked).
"""
import json, os, shutil, sys, tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="practice-test-"))
shutil.copytree(REPO / "example-library", TMP / "lib")
os.environ["STUDY_HUB_ROOT"] = str(TMP / "lib")
sys.path.insert(0, str(REPO))

import library as L
import tutor as T

FAILED = []


def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        FAILED.append(name)


PLAN = {"topics": [{"name": "Overview", "slides": "s2–s5", "problems": []},
                   {"name": "Text Foundations", "slides": "s7–s12", "problems": ["(a) BPE, s9", "(a2) WordPiece, s9"]}]}
FIRST = "#### Topic 0 · Overview: concepts\n\n| # | Question | Answer | Slide |\n\nSay **done** …\n" \
        f"<!--practice {json.dumps(PLAN, ensure_ascii=False)}-->\n"


def new_chat():
    return {"id": "x", "practice": {"deck": "SD-1", "topics": [], "at": 0, "started": ""}}


# ---- is_done
for s in ("done", "Done.", " DONE ", "done!", "next", "next topic", "Next topic.", "I’m done", "okay done",
          "Done, thanks", "next?", "next one", "continue", "ok done"):
    check(f"is_done({s!r})", T.is_done(s))
for s in ("done with step 2, but why divide by n?", "", "not done", "what is next?"):
    check(f"not is_done({s!r})", not T.is_done(s))

# ---- the plan line
chat = new_chat()
out = T._practice_record(chat, FIRST)
check("plan line stripped", "<!--practice" not in out and out.startswith("#### Topic 0"))
check("plan stored", [t["name"] for t in chat["practice"]["topics"]] == ["Overview", "Text Foundations"])
check("plan problems kept", chat["practice"]["topics"][1]["problems"] == ["(a) BPE, s9", "(a2) WordPiece, s9"])
check("at starts at 0", chat["practice"]["at"] == 0)

broken = new_chat()
out = T._practice_record(broken, "text\n<!--practice {not json}-->\n")
check("broken plan line stripped", "<!--practice" not in out)
check("broken plan leaves topics empty", broken["practice"]["topics"] == [])

kept = new_chat()
kept["practice"]["topics"] = PLAN["topics"]
T._practice_record(kept, "later turn\n<!--practice {\"topics\": [{\"name\": \"Other\"}]}-->")
check("a later plan line doesn't replace the plan", kept["practice"]["topics"][0]["name"] == "Overview")

# stored topic numbers win over the name guess (review 2)
numbered = new_chat()
T._practice_record(numbered, 'x\n<!--practice {"topics": [{"k": 1, "name": "Introduction to Bayes", "slides": "s2", "problems": []}, '
                   '{"k": 2, "name": "Priors", "slides": "s5", "problems": []}]}-->')
check("plan keeps topic numbers", [t.get("k") for t in numbered["practice"]["topics"]] == [1, 2])
check("stored number used", T._topic_no(numbered["practice"], 1) == 2)

# ---- the prompts
cdir = L.course_dirs()[0]
chat = new_chat()
chat["practice"]["topics"] = PLAN["topics"]
p = T._practice_prompt(cdir, chat, "practice_reply", "done")
check("done prompt names the next topic", "Topic 1: Text Foundations" in p and "s7–s12" in p, p[:300])
check("done prompt lists its problems", "(a) BPE, s9" in p and "(a2) WordPiece, s9" in p)
check("prompt alone doesn't advance", chat["practice"]["at"] == 0)
p1 = T._practice_prompt(cdir, dict(chat, practice=dict(chat["practice"], topics=PLAN["topics"] + [{"name": "Third", "slides": "s13", "problems": []}])), "practice_reply", "done")
check("the last line is given by the request, not fixed in the format", "Topic <k+1>" not in p and "Topic <k+1>" not in p1)
check("last topic's done line is the wrap-up", "wrap up the deck" in p and "Topic 2" not in p)
chat["practice"]["at"] = 1
p = T._practice_prompt(cdir, chat, "practice_reply", "done")
check("done at the last topic closes", "every topic" in p and "Topic 2" not in p, p[:300])
p = T._practice_prompt(cdir, chat, "practice_reply", "why divide by n?")
check("a question stays in the topic", "don't move on" in p and "Text Foundations" in p and "why divide by n?" in p)
p = T._practice_prompt(cdir, new_chat(), "practice_reply", "done")
check("done with no stored plan falls back", "next topic of your plan" in p)
p = T._practice_prompt(cdir, new_chat(), "practice", "")
check("opening prompt carries the format", all(s in p for s in (
    "| # | Topic | Slides | Numerical problems | Concept / MCQ areas |", "| # | Question | Answer | Slide |",
    "**Your turn:**", "<details><summary>Answer</summary>", "<!--practice", "Say **done**", "mean pooling")))

# ---- a whole turn, model stubbed
calls = []


def fake_run(cdir, system, prompt, **kw):
    calls.append({"system": system, "prompt": prompt, **kw})
    text = FIRST if "<!--practice" in prompt and kw.get("label") == "chat:practice" else "#### Topic 1 · Text Foundations: concepts\n"
    return {"text": text, "json": None, "session": "s1", "ms": 1, "cost": 0, "tokens": {}}


T.run_model = fake_run
before = T.current_chat(cdir)
lecture = [d["tag"] for d in L.deck_order(cdir) if d["tag"] not in L.course_info(cdir)["practice"]][0]
chat, msg = T.chat_turn(cdir, lecture, 1, "ask", "hello", "claude-opus-5-5", True)
normal = chat["id"]
chat, msg = T.chat_turn(cdir, lecture, 1, "practice", "", "claude-opus-5-5", True)
check("practice starts its own chat", chat["id"] != normal)
check("practice chat title", chat["title"] == f"Practice by topic · {lecture}", chat["title"])
check("saved text has no plan line", "<!--practice" not in msg["text"])
check("practice runs slides only", calls[-1]["web"] is False)
check("plan saved on the chat", len(T.load_chat(chat["id"])["practice"]["topics"]) == 2)
check("practice deck pinned", chat["practice"]["deck"] == lecture)
other = [d["tag"] for d in L.deck_order(cdir)][-1]
check("system prompt pinned to the practice deck",
      T.chat_system(cdir, chat, other, True) == T.system_prompt(cdir, lecture, False))

chat, msg = T.chat_turn(cdir, other, 1, "practice_reply", "why?", "claude-opus-5-5", True)
check("a question keeps the chat", chat["id"] == T.load_chat(chat["id"])["id"] and chat["practice"]["at"] == 0)
check("a reply also runs slides only", calls[-1]["web"] is False)
chat, msg = T.chat_turn(cdir, other, 1, "practice_reply", "done", "claude-opus-5-5", True)
check("done advances after the turn", T.load_chat(chat["id"])["practice"]["at"] == 1)
check("other turns in a practice chat run slides only too", (T.chat_turn(cdir, other, 1, "explain", "", "claude-opus-5-5", True), calls[-1]["web"])[1] is False)
T.S.set_chat(cdir, chat["id"])
chat, msg = T.chat_turn(cdir, other, 1, "practice_reply", "done", "claude-opus-5-5", True)
check("done past the last topic marks it finished", T.load_chat(chat["id"])["practice"].get("finished") is True
      and T.load_chat(chat["id"])["practice"]["at"] == 1)

# two "done"s sent at once present the same topic, and land on it once (review 1)
c2 = T.load_chat(chat["id"])
c2["practice"].update(at=0, finished=False, topics=PLAN["topics"] + [{"name": "Third", "slides": "s13", "problems": []}])
c2["messages"] = c2["messages"][:-2]
T.save_chat(c2)
real = T.run_model
def racing(*a, **kw):          # a second "done" is saved while the first is being answered
    if not racing.busy:
        racing.busy = True
        T.chat_turn(cdir, other, 1, "practice_reply", "done", "claude-opus-5-5", True)
    return real(*a, **kw)
racing.busy = False
T.run_model = racing
T.chat_turn(cdir, other, 1, "practice_reply", "done", "claude-opus-5-5", True)
T.run_model = real
check("two dones at once move one topic", T.load_chat(chat["id"])["practice"]["at"] == 1, T.load_chat(chat["id"])["practice"])

# /practice with words keeps them (review 10)
T.chat_turn(cdir, lecture, 1, "practice", "focus on the formulas", "claude-opus-5-5", True)
check("/practice words reach the prompt", "focus on the formulas" in calls[-1]["prompt"])

T.S.set_chat(cdir, normal)
try:
    T.chat_turn(cdir, lecture, 1, "practice_reply", "done", "claude-opus-5-5", True)
    check("practice_reply outside a practice chat refused", False)
except T.TutorError as e:
    check("practice_reply outside a practice chat refused", "Practice by topic" in str(e))

# ---- the server route
import server




check("server refuses an empty practice reply", "practice_reply" in Path(server.__file__).read_text(encoding="utf-8")
      .split('if mode in ("ask"', 1)[1].split(")", 1)[0])
check("server returns the practice state", '"practice": chat.get("practice")' in Path(server.__file__).read_text(encoding="utf-8"))

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{len(FAILED)} failed" if FAILED else "\nall passed")
sys.exit(1 if FAILED else 0)
