# Fine-tuning (future phase — not run during app development)

Order of work, per the project plan:
1. **Collect permitted feedback.** Thumbs up/down and corrections on answers are stored in `MessageFeedback`
   only when the user ticks "allow use for improving Aura" (`consent=True`).
2. **Build datasets.** `python -m finetuning.build_dataset` exports consented feedback to
   `finetuning/data/sft.jsonl` (corrected answers) and `finetuning/data/preferences.jsonl` (chosen/rejected pairs).
3. **LoRA SFT.** `python -m finetuning.train_lora --data finetuning/data/sft.jsonl` (PEFT LoRA on Apple Silicon MPS).
   QLoRA needs CUDA (`bitsandbytes`); run it on a cloud GPU with `--qlora`.
4. **Preference optimization (DPO) / RLHF** only after a few hundred quality preference pairs exist.
5. **Evaluate** before/after with `python -m evaluation.run` (faithfulness, relevance, citation correctness, latency).

Install extra deps only when needed: `pip install -r finetuning/requirements.txt`.
