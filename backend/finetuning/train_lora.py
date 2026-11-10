"""LoRA / QLoRA supervised fine-tuning of Llama 3.1 8B Instruct with Hugging Face PEFT + TRL.
Not executed during app development. Requires `pip install -r finetuning/requirements.txt` and HF access to
meta-llama/Llama-3.1-8B-Instruct. On a 16 GB Mac, LoRA on the full 8B model is impractical; use a cloud GPU (--qlora)."""
import argparse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--base", default="meta-llama/Llama-3.1-8B-Instruct")
    ap.add_argument("--out", default="finetuning/out/aura-lora")
    ap.add_argument("--qlora", action="store_true")
    ap.add_argument("--epochs", type=int, default=2)
    a = ap.parse_args()

    import torch
    from datasets import load_dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from trl import SFTConfig, SFTTrainer

    quant = None
    if a.qlora:
        from transformers import BitsAndBytesConfig
        quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16)
    tok = AutoTokenizer.from_pretrained(a.base)
    model = AutoModelForCausalLM.from_pretrained(a.base, quantization_config=quant, torch_dtype=torch.bfloat16,
                                                 device_map="auto")
    lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM",
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    trainer = SFTTrainer(model=model, processing_class=tok, peft_config=lora,
                         train_dataset=load_dataset("json", data_files=a.data)["train"],
                         args=SFTConfig(output_dir=a.out, num_train_epochs=a.epochs, per_device_train_batch_size=1,
                                        gradient_accumulation_steps=8, learning_rate=2e-4, logging_steps=10, save_strategy="epoch"))
    trainer.train()
    trainer.save_model(a.out)


if __name__ == "__main__":
    main()
